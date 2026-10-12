import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createConversationImages, mergeConversationImages, normalizeConversationGroups, UNGROUPED_IMAGES_ID,
} from './conversation-images.js';

const image = id => ({ id, name: `${id}.png`, url: `/references/${id}.png` });

test('images deduplicate within a group without mutating persisted reference objects', () => {
  const original = image('front');
  const result = mergeConversationImages([original], [image('front'), image('side')]);
  assert.deepEqual(result.map(item => item.id), ['front', 'side']);
  result[0].name = 'changed';
  assert.equal(original.name, 'front.png');
});

test('group normalization keeps deliberate cross-group reuse and bounds total images', () => {
  const groups = normalizeConversationGroups([
    { id: 'a', label: '  整体形状  ', images: [image('front'), image('front')] },
    { id: 'b', label: '材质', images: [image('front'), ...Array.from({ length: 20 }, (_, i) => image(`detail-${i}`))] },
  ]);
  assert.equal(groups[0].label, '整体形状');
  assert.equal(groups[0].images.length, 1);
  assert.equal(groups[1].images[0].id, 'front');
  assert.equal(groups.reduce((count, group) => count + group.images.length, 0), 16);
});

test('manual empty drafts survive normalization, while IDs, labels and group count stay bounded', () => {
  const groups = normalizeConversationGroups([
    { id: UNGROUPED_IMAGES_ID, images: [] },
    { id: 'empty', images: [] },
    ...Array.from({ length: 10 }, (_, i) => ({ id: 'reused', label: i ? '长'.repeat(90) : ' ', images: [image(String(i))] })),
  ]);
  assert.equal(groups.length, 8);
  assert.equal(new Set(groups.map(group => group.id)).size, 8);
  assert.equal(groups[0].id, 'empty');
  assert.deepEqual(groups[0].images, []);
  assert.equal(groups[0].label, '图片组 1');
  assert.equal(groups[2].label.length, 60);
  assert.equal(groups.some(group => group.id === UNGROUPED_IMAGES_ID), false);
});

// A small DOM surface lets these tests exercise the real event handlers without
// adding a browser dependency or depending on the component's visual layout.
class Element {
  constructor(tag, ownerDocument) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentElement = null;
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.files = [];
    this.disabled = false;
    this.hidden = false;
    this.scrollTop = 0;
    this.clickCount = 0;
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      toggle: (name, force) => {
        const add = force ?? !this.classList.contains(name);
        this.classList[add ? 'add' : 'remove'](name);
        return add;
      },
    };
  }
  append(...nodes) {
    for (const node of nodes) {
      if (node.tagName === '#FRAGMENT') { this.append(...node.children); continue; }
      node.parentElement = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    this.children.forEach(node => { node.parentElement = null; });
    this.children = [];
    this.append(...nodes);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) {
    if (name.startsWith('data-')) return this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] ?? null;
    return this.attributes.get(name) ?? null;
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  dispatch(type, values = {}) {
    const event = {
      target: this, currentTarget: this, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...values,
    };
    for (const listener of this.listeners.get(type) || []) listener(event);
    return event;
  }
  click() { if (!this.disabled) { this.clickCount++; this.dispatch('click'); } }
  focus() { this.ownerDocument.activeElement = this; }
  select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
  blur() { this.dispatch('blur'); }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  matches(selector) {
    const tag = selector.match(/^[a-z]+/i)?.[0];
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    for (const [, name] of selector.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(name)) return false;
    for (const [, name, value] of selector.matchAll(/\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]/g)) {
      const actual = this.getAttribute(name);
      if (actual === null || (value !== undefined && actual !== value)) return false;
    }
    return true;
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...(selector.split(',').some(part => child.matches(part.trim())) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function component(options = {}) {
  const doc = {
    createElement(tag) { return new Element(tag, doc); },
    createDocumentFragment() { return new Element('#fragment', doc); },
  };
  const container = doc.createElement('div');
  const input = doc.createElement('input');
  const addButton = doc.createElement('button');
  const groupButton = doc.createElement('button');
  const dropTarget = doc.createElement('form');
  dropTarget.append(container, input, addButton, groupButton);
  const errors = [], uploads = [];
  const draft = createConversationImages({
    container, input, addButton, groupButton, dropTarget,
    uploadFiles: async files => {
      uploads.push(files);
      return options.uploadFiles ? options.uploadFiles(files) : files.map(file => image(file.id));
    },
    getProjectKey: options.getProjectKey || (() => 'project-a'),
    onError: error => errors.push(error.message),
  });
  const groupElement = id => container.querySelectorAll('[data-image-group]').find(node => node.dataset.imageGroup === id);
  const button = (root, label) => {
    const match = root.querySelectorAll('button').find(node => label.test(node.getAttribute('aria-label') || ''));
    assert.ok(match, `Expected an accessible button matching ${label}`);
    return match;
  };
  return { draft, container, input, addButton, groupButton, dropTarget, errors, uploads, groupElement, button };
}

const file = id => ({ id, name: `${id}.png`, type: 'image/png' });
const settleEvents = () => new Promise(resolve => setImmediate(resolve));
const imageIds = group => group.images.map(item => item.id);

async function chooseFiles(env, files, button = env.addButton) {
  button.click();
  env.input.files = files;
  env.input.dispatch('change');
  await settleEvents();
}

async function dropFiles(env, files, target = env.dropTarget) {
  const event = env.dropTarget.dispatch('drop', { target, dataTransfer: { types: ['Files'], files } });
  await settleEvents();
  assert.equal(event.defaultPrevented, true);
}

async function pasteFiles(env, files, target = env.dropTarget) {
  const event = env.dropTarget.dispatch('paste', { target, clipboardData: { files } });
  await settleEvents();
  assert.equal(event.defaultPrevented, true);
}

test('repeated ordinary selection, upload, drop and paste append to one ungrouped attachment draft', async () => {
  const env = component();
  await chooseFiles(env, [file('front')]);
  await chooseFiles(env, [file('side')]);
  await env.draft.upload([file('top')]);
  await dropFiles(env, [file('back')]);
  await pasteFiles(env, [file('detail')]);

  const groups = env.draft.getGroups();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].id, UNGROUPED_IMAGES_ID);
  assert.deepEqual(imageIds(groups[0]), ['front', 'side', 'top', 'back', 'detail']);
  assert.equal(env.container.querySelectorAll('input').length, 0, 'ordinary attachments expose no group-name field');
  assert.deepEqual(env.draft.getTaskGroups(), [{ id: UNGROUPED_IMAGES_ID, label: '补充图片', referenceIds: imageIds(groups[0]) }]);
  assert.deepEqual(env.errors, []);
});

test('explicit creation preserves an empty manual group without opening a chooser or sending an empty group', () => {
  const env = component();
  env.groupButton.click();
  const [group] = env.draft.getGroups();
  assert.ok(group);
  assert.notEqual(group.id, UNGROUPED_IMAGES_ID);
  assert.deepEqual(group.images, []);
  assert.equal(env.input.clickCount, 0);
  assert.deepEqual(env.draft.getTaskGroups(), []);

  env.draft.setGroups(env.draft.getGroups());
  assert.deepEqual(env.draft.getGroups(), [group], 'switching back to a saved draft retains the empty manual group');
  assert.deepEqual(env.draft.getTaskGroups(), []);
});

test('group add, targeted drop and targeted paste stay in the explicitly chosen group', async () => {
  const env = component();
  env.groupButton.click();
  const [group] = env.draft.getGroups();
  await chooseFiles(env, [file('side')], env.button(env.groupElement(group.id), /添加图片/));
  await dropFiles(env, [file('back')], env.groupElement(group.id).querySelector('img'));
  await pasteFiles(env, [file('detail')], env.groupElement(group.id).querySelector('input'));
  await env.draft.upload([file('side')], group.id);

  assert.deepEqual(env.draft.getGroups().map(item => item.id), [group.id]);
  assert.deepEqual(imageIds(env.draft.getGroups()[0]), ['side', 'back', 'detail']);
  assert.deepEqual(env.draft.getTaskGroups(), [{ id: group.id, label: group.label, referenceIds: ['side', 'back', 'detail'] }]);
  assert.deepEqual(env.errors, []);
});

test('removing the last image keeps a manual group but removes an empty ordinary attachment draft', async () => {
  const env = component();
  env.groupButton.click();
  const [group] = env.draft.getGroups();
  await env.draft.upload([file('manual')], group.id);
  await env.draft.upload([file('ordinary')]);
  env.button(env.container, /^移除图片：manual\.png$/).click();
  assert.deepEqual(env.draft.getGroups().find(item => item.id === group.id).images, []);
  assert.deepEqual(env.draft.getTaskGroups().map(item => item.id), [UNGROUPED_IMAGES_ID]);
  env.button(env.container, /^移除图片：ordinary\.png$/).click();
  assert.deepEqual(env.draft.getGroups(), [group]);
  assert.deepEqual(env.draft.getTaskGroups(), []);
});

test('eight slots with ordinary attachments still accept pictures while blocking creation of a ninth group', async () => {
  const env = component();
  env.draft.setGroups([
    { id: UNGROUPED_IMAGES_ID, images: [image('ordinary')] },
    ...Array.from({ length: 7 }, (_, index) => ({ id: `manual-${index}`, label: `细节 ${index}`, images: [] })),
  ]);
  assert.equal(env.groupButton.disabled, true);
  assert.equal(env.addButton.disabled, false);
  await chooseFiles(env, [file('more')]);
  await env.draft.upload([file('named')], 'manual-0');
  assert.equal(env.draft.getGroups().length, 8);
  assert.deepEqual(imageIds(env.draft.getGroups().find(group => group.id === UNGROUPED_IMAGES_ID)), ['ordinary', 'more']);
  assert.deepEqual(imageIds(env.draft.getGroups().find(group => group.id === 'manual-0')), ['named']);
  assert.deepEqual(env.errors, []);
});

test('eight manual groups reject ordinary uploads before persistence but accept additions inside a group', async () => {
  const env = component();
  env.draft.setGroups(Array.from({ length: 8 }, (_, index) => ({ id: `manual-${index}`, label: `细节 ${index}`, images: [] })));
  assert.equal(env.groupButton.disabled, true);
  assert.equal(await env.draft.upload([file('ordinary')]), false);
  assert.equal(env.uploads.length, 0, 'a group-limit failure must not create an unused project reference');
  assert.equal(env.errors.length, 1);
  assert.equal(await env.draft.upload([file('named')], 'manual-0'), true);
  assert.equal(env.draft.getGroups().length, 8);
  assert.equal(env.draft.getGroups().some(group => group.id === UNGROUPED_IMAGES_ID), false);
  assert.deepEqual(env.draft.getTaskGroups(), [{ id: 'manual-0', label: '细节 0', referenceIds: ['named'] }]);
});

test('clear or project draft replacement makes an unfinished upload stale', async () => {
  for (const replace of ['clear', 'switch-project']) {
    let projectKey = 'project-a', finishUpload;
    const env = component({
      getProjectKey: () => projectKey,
      uploadFiles: () => new Promise(resolve => { finishUpload = resolve; }),
    });
    const uploading = env.draft.upload([file('stale')]);
    const next = [{ id: 'project-b-group', label: '新项目', images: [image('current')] }];
    if (replace === 'clear') env.draft.clear();
    else { projectKey = 'project-b'; env.draft.setGroups(next); }
    finishUpload([image('stale')]);
    assert.equal(await uploading, false, replace);
    assert.deepEqual(env.draft.getGroups(), replace === 'clear' ? [] : next, replace);
    assert.equal(env.addButton.disabled, false, 'the next draft unlocks after the obsolete upload settles');
    assert.deepEqual(env.errors, []);
  }
});

test('files chosen after switching projects do not upload into the new draft', async () => {
  let projectKey = 'project-a';
  const env = component({ getProjectKey: () => projectKey });
  env.addButton.click();
  projectKey = 'project-b';
  const next = [{ id: 'new-group', label: '新项目', images: [] }];
  env.draft.setGroups(next);
  env.input.files = [file('stale-choice')];
  env.input.dispatch('change');
  await settleEvents();
  assert.equal(env.uploads.length, 0);
  assert.deepEqual(env.draft.getGroups(), next);
});
