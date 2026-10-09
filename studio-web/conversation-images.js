export const CONVERSATION_IMAGE_LIMIT = 16;
export const CONVERSATION_GROUP_LIMIT = 8;

const uid = () => globalThis.crypto.randomUUID();
const copyImage = image => ({ id: String(image.id), name: String(image.name || '参考图片'), url: String(image.url || '') });

export function mergeConversationImages(current = [], incoming = [], limit = CONVERSATION_IMAGE_LIMIT) {
  const images = [];
  const seen = new Set();
  for (const image of [...current, ...incoming]) {
    if (!image?.id || seen.has(String(image.id)) || images.length >= limit) continue;
    seen.add(String(image.id));
    images.push(copyImage(image));
  }
  return images;
}

export function normalizeConversationGroups(value = []) {
  const groups = [];
  const groupIds = new Set();
  let remaining = CONVERSATION_IMAGE_LIMIT;
  for (const source of Array.isArray(value) ? value : []) {
    if (groups.length >= CONVERSATION_GROUP_LIMIT || remaining < 1) break;
    const images = mergeConversationImages([], Array.isArray(source?.images) ? source.images : [], remaining);
    if (!images.length) continue;
    let id = String(source.id || uid());
    if (groupIds.has(id)) id = uid();
    groupIds.add(id);
    groups.push({ id, label: String(source.label || '').trim().slice(0, 60) || `图片组 ${groups.length + 1}`, images });
    remaining -= images.length;
  }
  return groups;
}

/** Draft-only image groups. Uploading persists references; removal here never deletes the project library. */
export function createConversationImages({
  container, input, addButton, dropTarget, uploadFiles,
  onChange = () => {}, onError = () => {}, isLocked = () => false, getProjectKey = () => null,
}) {
  if (!container || !input || !addButton || !dropTarget || typeof uploadFiles !== 'function') {
    throw new Error('会话图片组缺少必要的界面节点或上传函数。');
  }
  const doc = container.ownerDocument;
  let groups = [];
  let generation = 0;
  let uploading = false;
  let chooserGroup = null;
  let chooserProject;
  let chooserGeneration = 0;
  let chooserOpened = false;
  const countImages = () => groups.reduce((total, group) => total + group.images.length, 0);
  const getGroups = () => groups.map((group, index) => ({
    id: group.id,
    label: group.label.trim().slice(0, 60) || `图片组 ${index + 1}`,
    images: group.images.map(copyImage),
  }));
  const emit = () => onChange(getGroups(), { uploading });
  const fail = message => onError(new Error(message));
  const blocked = () => uploading || isLocked();
  const findGroup = id => groups.find(group => group.id === id);
  const element = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const action = (className, text, label, handler) => {
    const button = element('button', className, text);
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.title = label;
    button.addEventListener('click', handler);
    return button;
  };
  const clearDropState = () => {
    dropTarget.classList.remove('conversation-drop-over');
    for (const node of container.querySelectorAll('.conversation-image-group.drop-over')) node.classList.remove('drop-over');
  };

  function refresh() {
    const locked = blocked();
    const full = countImages() >= CONVERSATION_IMAGE_LIMIT;
    addButton.disabled = locked || full || groups.length >= CONVERSATION_GROUP_LIMIT;
    input.disabled = locked || full;
    addButton.setAttribute('aria-busy', String(uploading));
    addButton.title = uploading ? '正在添加图片…' : full ? '本次会话最多添加 16 张图片' : '添加一组参考图片，也可以拖入或粘贴图片';
    container.setAttribute('aria-busy', String(uploading));
    container.dataset.uploading = String(uploading);
    for (const button of container.querySelectorAll('button')) {
      button.disabled = locked || (button.classList.contains('conversation-image-add') && full);
    }
    for (const field of container.querySelectorAll('.conversation-image-label')) field.disabled = locked;
    const status = container.querySelector('.conversation-image-upload-status');
    if (status) status.hidden = !uploading;
    container.hidden = !groups.length && !uploading;
    if (locked) clearDropState();
  }

  function choose(groupId = null) {
    if (blocked()) return;
    if (!groupId && groups.length >= CONVERSATION_GROUP_LIMIT) return fail('本次会话最多添加 8 组图片。');
    if (countImages() >= CONVERSATION_IMAGE_LIMIT) return fail('本次会话最多添加 16 张图片。');
    chooserGroup = groupId;
    chooserProject = getProjectKey();
    chooserGeneration = generation;
    chooserOpened = true;
    input.value = '';
    input.click();
  }

  function render() {
    const scrollTop = container.scrollTop;
    const fragment = doc.createDocumentFragment();
    groups.forEach((group, index) => {
      const groupElement = element('section', 'conversation-image-group');
      groupElement.dataset.imageGroup = group.id;
      groupElement.setAttribute('aria-label', group.label || `图片组 ${index + 1}`);
      const header = element('div', 'conversation-image-group-header');
      const label = element('input', 'conversation-image-label');
      label.type = 'text';
      label.value = group.label;
      label.maxLength = 60;
      label.placeholder = `图片组 ${index + 1}`;
      label.setAttribute('aria-label', `第 ${index + 1} 组图片的名称`);
      label.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); label.blur(); }
      });
      label.addEventListener('input', () => {
        group.label = label.value.slice(0, 60);
        groupElement.setAttribute('aria-label', group.label || `图片组 ${index + 1}`);
        emit();
      });
      label.addEventListener('blur', () => {
        const normalized = group.label.trim() || `图片组 ${index + 1}`;
        if (group.label !== normalized) { group.label = normalized; label.value = normalized; emit(); }
      });
      header.append(label, element('span', 'conversation-image-count', `${group.images.length} 张`));
      header.append(action('conversation-image-remove-group', '×', `移除${group.label || `图片组 ${index + 1}`}`, () => {
        if (blocked()) return;
        groups = groups.filter(item => item.id !== group.id);
        render(); emit();
      }));
      const grid = element('div', 'conversation-image-grid');
      for (const image of group.images) {
        const tile = element('div', 'conversation-image-tile');
        const thumbnail = element('img');
        thumbnail.src = image.url;
        thumbnail.alt = image.name;
        thumbnail.title = image.name;
        thumbnail.loading = 'lazy';
        thumbnail.decoding = 'async';
        thumbnail.draggable = false;
        tile.append(thumbnail, action('conversation-image-remove', '×', `移除图片：${image.name}`, () => {
          if (blocked()) return;
          group.images = group.images.filter(item => item.id !== image.id);
          if (!group.images.length) groups = groups.filter(item => item.id !== group.id);
          render(); emit();
        }));
        grid.append(tile);
      }
      grid.append(action('conversation-image-add', '+', `向${group.label || `图片组 ${index + 1}`}添加图片`, () => choose(group.id)));
      groupElement.append(header, grid);
      fragment.append(groupElement);
    });
    const status = element('p', 'conversation-image-upload-status', '正在添加图片…');
    status.setAttribute('role', 'status');
    status.hidden = !uploading;
    fragment.append(status);
    container.replaceChildren(fragment);
    refresh();
    container.scrollTop = scrollTop;
  }

  async function upload(fileList, groupId = null) {
    const files = Array.from(fileList || []);
    if (!files.length || blocked()) return false;
    if (groupId && !findGroup(groupId)) return false;
    if (!groupId && groups.length >= CONVERSATION_GROUP_LIMIT) { fail('本次会话最多添加 8 组图片。'); return false; }
    const remaining = CONVERSATION_IMAGE_LIMIT - countImages();
    if (files.length > remaining) { fail(`本次会话最多添加 16 张图片，还可以添加 ${remaining} 张。`); return false; }
    const projectKey = getProjectKey();
    const revision = generation;
    const isCurrent = () => projectKey === getProjectKey() && revision === generation;
    uploading = true;
    refresh(); emit();
    try {
      const uploaded = await uploadFiles(files);
      if (!isCurrent() || isLocked()) return false;
      const images = mergeConversationImages([], Array.isArray(uploaded) ? uploaded : [], remaining);
      if (!images.length) return false;
      if (groupId) {
        const target = findGroup(groupId);
        if (!target) return false;
        target.images = mergeConversationImages(target.images, images, target.images.length + remaining);
      } else {
        let number = groups.length + 1;
        while (groups.some(group => group.label === `图片组 ${number}`)) number++;
        groups.push({ id: uid(), label: `图片组 ${number}`, images });
      }
      render();
      return true;
    } catch (error) {
      if (isCurrent()) onError(error instanceof Error ? error : new Error(String(error)));
      return false;
    } finally {
      uploading = false;
      refresh(); emit();
    }
  }

  addButton.addEventListener('click', () => choose());
  input.addEventListener('change', () => {
    const files = Array.from(input.files || []);
    input.value = '';
    const groupId = chooserGroup;
    chooserGroup = null;
    const stale = chooserOpened && (chooserProject !== getProjectKey() || chooserGeneration !== generation);
    chooserOpened = false;
    if (!stale) void upload(files, groupId);
  });
  const isFileDrag = event => Array.from(event.dataTransfer?.types || []).includes('Files');
  const eventGroup = event => event.target?.closest?.('[data-image-group]');
  const showDropState = event => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    if (blocked()) { event.dataTransfer.dropEffect = 'none'; return; }
    event.dataTransfer.dropEffect = 'copy';
    clearDropState();
    const groupElement = eventGroup(event);
    if (groupElement && container.contains(groupElement)) groupElement.classList.add('drop-over');
    else dropTarget.classList.add('conversation-drop-over');
  };
  dropTarget.addEventListener('dragenter', showDropState);
  dropTarget.addEventListener('dragover', showDropState);
  dropTarget.addEventListener('dragleave', event => {
    if (!dropTarget.contains(event.relatedTarget)) clearDropState();
  });
  dropTarget.addEventListener('dragend', clearDropState);
  dropTarget.addEventListener('drop', event => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    const groupElement = eventGroup(event);
    const groupId = groupElement && container.contains(groupElement) ? groupElement.dataset.imageGroup : null;
    if (groupId) event.stopPropagation();
    clearDropState();
    void upload(event.dataTransfer.files, groupId);
  });
  dropTarget.addEventListener('paste', event => {
    const images = Array.from(event.clipboardData?.files || []).filter(file => file.type.startsWith('image/'));
    if (!images.length) return;
    event.preventDefault();
    void upload(images);
  });

  render();
  return {
    getGroups,
    setGroups(next) { generation++; groups = normalizeConversationGroups(next); clearDropState(); render(); emit(); },
    clear() { generation++; groups = []; clearDropState(); render(); emit(); },
    refresh,
    upload,
  };
}
