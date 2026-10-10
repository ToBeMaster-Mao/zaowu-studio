import { partLabel, partDetail } from './part-labels.js';
import { createCreationParticles } from './creation-particles.js';
import { describeTask, elapsedLabel } from './task-status.js';
import { createConversationImages } from './conversation-images.js';
import { enhanceSelect } from './select-menu.js';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const token = $('meta[name="studio-token"]').content;
let displayPreferences = {};
try { displayPreferences = JSON.parse(localStorage.getItem('studio-display-preferences')) || {}; } catch { /* Use defaults if local preferences are unavailable. */ }
const state = {
  projects: [], project: null, bridge: { connected: false, models: [] },
  parts: [], selection: null, camera: null, ready: false, iframe: null,
  modelKey: '', modelChoice: '', activeTab: 'parts', openCategories: new Set(['cockpit']), expandedPartLists: new Set(),
  toggles: { wireframe: false, grid: false, animate: false, clay: displayPreferences.clay === true, explode: false }, liveMessages: new Map(),
  background: displayPreferences.background === 'light' ? 'light' : 'dark', canExplode: false, hasMeshes: false, hasAnimation: false,
  approvals: new Map(), loadingProject: 0, taskSubmitting: false, skillUrl: '/downloads/model-studio-skill.zip',
  referenceIds: new Set(), uploading: false, submitIntent: 'chat', submittedAt: null,
  stoppingTaskId: null, streamConnected: true, activity: '', lastActivityAt: null, submissionError: null,
  serverCreating: false, approvalSnapshot: [],
  referencesFresh: false,
  previewRevision: null, previewLoadingId: null, previewRequest: 0, revisionPreviewApi: false,
  displayRevisionId: null, displayOverrides: {}, restoringVersion: false, savingParts: 0,
  imageGroupsEnabled: false, imageLimits: { perTask: 8, projectLibrary: 128 }, conversationDrafts: new Map(),
};
const revisionCache = new Map();
// Visibility is scoped to this page session; project history and Agent context are retained.
const hiddenConversationIds = new Map();
const selectMenus = new Map(['projectSelect', 'modelSelect', 'cameraViewSelect'].map(id => [id, enhanceSelect($(`#${id}`))]));
const creationParticles = createCreationParticles($('#creationParticles'));
const pendingRpc = new Map();
const pendingPartUpdates = new Set();
let rpcId = 0;
let validationKey = '';
let refreshTimer;
const categoryLabels = { fuselage: '机身', cockpit: '驾驶舱', cabin: '客舱与舷窗', wings: '机翼', engines: '发动机', tail: '尾翼', 'landing-gear': '起落架', details: '模型部件' };
const categoryOrder = Object.keys(categoryLabels);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const partPreviewCount = 6;
const inspectorIcon = name => `<svg class="inspector-icon" viewBox="0 0 24 24" aria-hidden="true">${{
  chevron: '<path d="m7 9 5 5 5-5"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="m3 3 18 18M10.6 5.1 12 5c6.4 0 10 7 10 7a19 19 0 0 1-3 3.7M6.2 6.2A20 20 0 0 0 2 12s3.6 7 10 7a12 12 0 0 0 5.8-1.6M10 10a3 3 0 0 0 4 4"/>',
  collapse: '<path d="m8 7 4-4 4 4M8 17l4 4 4-4M4 12h16"/>',
  expand: '<path d="m8 3 4 4 4-4M8 21l4-4 4 4M4 12h16"/>',
}[name]}</svg>`;
const timeLabel = value => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
};
const isBusy = task => task && !['completed', 'failed', 'interrupted', 'cancelled', 'canceled', 'invalid', 'idle'].includes(task.status);
const localBusy = () => state.taskSubmitting || state.serverCreating || isBusy(state.project?.task) || Boolean(state.project?.pendingRevisionId);
const selectedReferences = () => (state.project?.references || []).filter(reference => state.referenceIds.has(reference.id));
const viewingHistory = () => Boolean(state.previewRevision || state.previewLoadingId);
const revisionNumber = id => (state.project?.versions || []).findIndex(version => version.id === id) + 1;
const conversationImages = createConversationImages({
  container: $('#conversationImageGroups'), input: $('#conversationImageInput'), addButton: $('#attachImagesButton'), dropTarget: $('#composer'),
  uploadFiles: files => persistImages(files, false),
  isLocked: () => !state.project || !state.imageGroupsEnabled || localBusy() || state.uploading || viewingHistory(),
  getProjectKey: () => state.project?.id,
  onChange: groups => {
    if (state.project) state.conversationDrafts.set(state.project.id, groups);
    renderTask();
  },
  onError: error => toast(error.message, true),
});
const draftImageGroups = () => conversationImages.getGroups().map(group => ({ id: group.id, label: group.label, referenceIds: group.images.map(image => image.id) }));
function rememberRevision(projectId, revisionId, overrides) {
  if (!revisionId) return;
  const snapshot = { id: revisionId, overrides: structuredClone(overrides || {}) };
  const key = `${projectId}:${revisionId}`;
  revisionCache.set(key, snapshot);
  try { sessionStorage.setItem(`studio-revision:${key}`, JSON.stringify(snapshot)); } catch { /* Memory cache remains available. */ }
}

function toast(message, error = false) {
  const node = document.createElement('div');
  node.className = `toast${error ? ' error' : ''}`;
  node.textContent = String(message);
  $('#toasts').append(node);
  setTimeout(() => node.remove(), error ? 8000 : 4200);
}

function syncPanelControls() {
  for (const [side, name] of [['left', '创作助手'], ['right', '部件面板']]) {
    const open = getComputedStyle($(`#${side}Panel`)).display !== 'none';
    const button = $(side === 'left' ? '#toggleLeft' : '#toggleRight');
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', `${open ? '收起' : '展开'}${name}`);
    button.title = `${open ? '收起' : '展开'}${name}`;
  }
}

function setPanelOpen(side, open) {
  const app = $('#app');
  const drawer = window.innerWidth <= (side === 'left' ? 690 : 980);
  app.classList.toggle(`${side}-open`, drawer && open);
  app.classList.toggle(`${side}-hidden`, !drawer && !open);
  syncPanelControls();
}

function renderDisplaySettings() {
  $('.stage').dataset.background = state.background;
  $$('.background-options [data-background]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.background === state.background)));
  $('#clayToggle').checked = state.toggles.clay;
  $('#clayToggle').disabled = !state.ready || !state.hasMeshes || localBusy();
  $('#explodeToggle').checked = state.toggles.explode;
  $('#explodeToggle').disabled = !state.ready || !state.canExplode || localBusy();
  $('#explodeToggle').closest('label').title = state.ready && !state.canExplode ? '需要两个以上可独立展开的部件' : '展开查看部件关系，关闭后合拢';
}

function saveDisplayPreferences() {
  try { localStorage.setItem('studio-display-preferences', JSON.stringify({ background: state.background, clay: state.toggles.clay })); } catch { /* The current preview remains usable without persistence. */ }
}

function setDisplaySettingsOpen(open, focus = false) {
  $('#displaySettingsPanel').hidden = !open;
  $('#displaySettingsButton').setAttribute('aria-expanded', String(open));
  if (focus) (open ? $('.background-options [aria-pressed="true"]') : $('#displaySettingsButton')).focus();
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'x-studio-token': token, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    ...(options.body && typeof options.body !== 'string' ? { body: JSON.stringify(options.body) } : {}),
  });
  let result;
  try { result = await response.json(); }
  catch { throw new Error(response.ok ? '服务返回了无法读取的数据' : `请求失败（${response.status}），请刷新页面后重试`); }
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : result.error?.message || result.message || `请求失败（${response.status}）`);
  return result;
}

function projectUrl(suffix = '', project = state.project) {
  if (!project) throw new Error('请先选择一个项目');
  return `/api/projects/${encodeURIComponent(project.id)}${suffix}`;
}

function showDialog(id) { const dialog = $(id); if (!dialog.open) dialog.showModal(); }
function setTab(tab) {
  state.activeTab = tab;
  $$('[data-tab]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.tab === tab)));
  ['parts', 'properties', 'versions'].forEach(name => { $(`#${name}Pane`).hidden = name !== tab; });
}

function renderProjects() {
  const select = $('#projectSelect');
  select.innerHTML = state.projects.map(project => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join('');
  if (state.project) select.value = state.project.id;
  selectMenus.get('projectSelect').refresh();
}

function rememberProject(project) {
  if (!project?.id) return;
  const index = state.projects.findIndex(item => item.id === project.id);
  if (index < 0) state.projects.unshift(project);
  else state.projects[index] = project;
}

function setProject(project, { forceLoad = false, keepViewport = false } = {}) {
  if (!project?.id) return;
  const switched = state.project?.id !== project.id;
  const changedTask = state.project?.task?.id !== project.task?.id;
  rememberRevision(project.id, project.pendingRevisionId || project.headId, project.overrides);
  if (switched || forceLoad || (project.pendingRevisionId && viewingHistory())) {
    if (!switched && project.pendingRevisionId && viewingHistory()) toast('新版本已生成，已切回当前模型进行预览校验。');
    state.previewRequest++; state.previewRevision = null; state.previewLoadingId = null;
  }
  rememberProject(project);
  if (switched && state.project) state.conversationDrafts.set(state.project.id, conversationImages.getGroups());
  state.project = project;
  if (switched) {
    conversationImages.setGroups(state.conversationDrafts.get(project.id) || []);
    state.liveMessages.clear();
    state.approvals.clear();
    state.selection = null;
    state.camera = null;
    state.openCategories = new Set(['cockpit']);
    state.expandedPartLists.clear();
    const validReferenceIds = new Set((project.references || []).map(reference => reference.id));
    state.referenceIds = new Set([...validReferenceIds].slice(0, state.imageLimits.perTask));
    state.referencesFresh = false;
    try {
      const remembered = JSON.parse(sessionStorage.getItem(`studio-references:${project.id}`));
      if (Array.isArray(remembered)) state.referenceIds = new Set(remembered.filter(id => validReferenceIds.has(id)).slice(0, state.imageLimits.perTask));
    } catch { /* Invalid preferences should not block opening a model. */ }
    $('#promptInput').value = '';
    $('#partSearch').value = '';
  }
  if (switched || changedTask) {
    state.activity = ''; state.lastActivityAt = null; state.submissionError = null; state.stoppingTaskId = null;
    state.liveMessages.clear();
  }
  if (!isBusy(project.task)) { state.stoppingTaskId = null; state.approvals.clear(); }
  syncApprovals();
  renderProjects();
  $('#stageProjectName').textContent = project.name;
  $('#sceneProjectName').textContent = project.name;
  document.title = `${project.name} · 造物 Studio`;
  $('#workspacePath').textContent = project.workspacePath || '';
  renderReferences();
  renderMessages();
  renderTask();
  renderVersions();
  renderSelection();
  const modelKey = `${project.id}:${project.modelUrl}`;
  renderPreviewBanner();
  if (state.previewRevision) return;
  if (keepViewport && !switched) state.modelKey = modelKey;
  if (forceLoad || switched || state.modelKey !== modelKey) loadModel(project, modelKey);
}

async function selectProject(id) {
  const request = ++state.loadingProject;
  const project = await api(`/api/projects/${encodeURIComponent(id)}`);
  if (request !== state.loadingProject) return;
  setProject(project);
  sessionStorage.setItem('studio-active-project', project.id);
}

function renderReferences() {
  const references = state.project?.references || [];
  state.referenceIds = new Set([...state.referenceIds].filter(id => references.some(reference => reference.id === id)));
  if (state.project) sessionStorage.setItem(`studio-references:${state.project.id}`, JSON.stringify([...state.referenceIds]));
  $('#referenceCount').textContent = '';
  $('#referenceSelectionCount').textContent = `已选 ${state.referenceIds.size} 张`;
  $('#selectAllReferences').textContent = references.length > state.imageLimits.perTask ? `选前 ${state.imageLimits.perTask} 张` : '全选';
  $('#selectAllReferences').disabled = !references.length || localBusy() || state.uploading;
  $('#clearReferenceSelection').disabled = !state.referenceIds.size || localBusy() || state.uploading;
  if (!references.length) {
    $('#references').innerHTML = '<button class="upload-empty" id="emptyUpload"><strong aria-hidden="true">＋</strong><span>拖入图片，或点击添加</span></button>';
    $('#emptyUpload').onclick = () => $('#referenceInput').click();
    return;
  }
  $('#references').innerHTML = references.map(reference => `<div class="reference-card ${state.referenceIds.has(reference.id) ? 'is-selected' : ''}"><label class="reference-choice"><img src="${escapeHtml(reference.url)}" alt="参考图片：${escapeHtml(reference.name)}"><input type="checkbox" data-reference="${escapeHtml(reference.id)}" aria-label="选用参考图 ${escapeHtml(reference.name)}" ${state.referenceIds.has(reference.id) ? 'checked' : ''} ${localBusy() || state.uploading ? 'disabled' : ''}><span class="reference-check" aria-hidden="true">${state.referenceIds.has(reference.id) ? '✓ 已选' : '选用'}</span></label><span class="ref-label">${escapeHtml(reference.name)}</span><button class="ref-remove" data-remove-reference="${escapeHtml(reference.id)}" aria-label="移除参考图 ${escapeHtml(reference.name)}" title="移除参考图" ${localBusy() || state.uploading ? 'disabled' : ''}>×</button></div>`).join('');
  $$('[data-reference]').forEach(input => { input.onchange = () => {
    if (input.checked && state.referenceIds.size >= state.imageLimits.perTask) { input.checked = false; return toast(`本轮最多选 ${state.imageLimits.perTask} 张项目参考图。`); }
    if (input.checked) state.referenceIds.add(input.dataset.reference); else state.referenceIds.delete(input.dataset.reference);
    state.submissionError = null; state.referencesFresh = true; renderReferences(); renderTask();
  }; });
  $('#references').insertAdjacentHTML('beforeend', '<button id="addMoreReferences" class="reference-upload-tile" aria-label="添加更多参考图片"><span aria-hidden="true">＋</span>添加图片</button>');
  $('#addMoreReferences').onclick = () => $('#referenceInput').click();
  $$('[data-remove-reference]').forEach(button => { button.onclick = async () => {
    button.disabled = true;
    const projectId = state.project.id;
    if (conversationImages.getGroups().some(group => group.images.some(image => image.id === button.dataset.removeReference))) {
      button.disabled = false;
      return toast('这张图已加入本轮图片组，请先从图片组移除。');
    }
    try {
      const result = await api(projectUrl(`/references/${encodeURIComponent(button.dataset.removeReference)}`), { method: 'DELETE' });
      if (state.project?.id === projectId) setProject(result);
    } catch (error) { toast(error.message, true); button.disabled = false; }
  }; });
}

function messageImages(message) {
  const attachments = message.attachments || [];
  if (!attachments.length) return '';
  const byId = new Map(attachments.map(image => [image.referenceId || image.id, image]));
  const groups = (message.imageGroups || []).map(group => ({ label: group.label, images: group.referenceIds.map(id => byId.get(id)).filter(Boolean) }));
  const groupedIds = new Set((message.imageGroups || []).flatMap(group => group.referenceIds));
  const projectImages = attachments.filter(image => !groupedIds.has(image.referenceId || image.id));
  if (projectImages.length) groups.unshift({ label: '项目参考图', images: projectImages });
  return groups.filter(group => group.images.length).map(group => `<div class="message-image-group"><p class="message-image-group-label">${escapeHtml(group.label)} · ${group.images.length} 张</p><div class="message-image-grid">${group.images.map(image => `<button type="button" data-message-image="${escapeHtml(image.url)}" data-image-name="${escapeHtml(image.name)}" aria-label="查看图片 ${escapeHtml(image.name)}"><img src="${escapeHtml(image.url)}" alt="${escapeHtml(image.name)}" loading="lazy"></button>`).join('')}</div></div>`).join('');
}

function renderMessages() {
  const container = $('#messages');
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
  const hiddenIds = hiddenConversationIds.get(state.project?.id);
  const messages = (state.project?.messages || []).filter(message => !hiddenIds?.has(message.id));
  $('#clearConversationButton').disabled = !messages.length || localBusy();
  $('#conversationHistoryNotice').hidden = !hiddenIds?.size;
  if (isBusy(state.project?.task) && state.project?.task?.status !== 'validating') {
    for (const [id, message] of state.liveMessages) messages.push({ id, role: 'assistant', text: message, live: true });
    if (!state.liveMessages.size) messages.push({ id: 'task-output', role: 'assistant', text: state.project.task.output || '', live: true });
  }
  if (!messages.length) {
    container.innerHTML = hiddenIds?.size ? '' : '<div class="empty-chat"><p>从一张参考图开始</p></div>';
    $('#newMessagesButton').hidden = true;
    return;
  }
  container.innerHTML = messages.map(message => {
    const user = message.role === 'user';
    return `<article class="message ${user ? 'user' : 'assistant'} ${message.live ? 'live' : ''}" aria-label="${user ? '你' : '创作助手'}" title="${escapeHtml(timeLabel(message.createdAt))}">${message.live ? '<div class="message-head"><span>正在回复</span><span class="typing-dots" aria-hidden="true"><span></span><span></span><span></span></span></div>' : ''}<div class="message-body">${escapeHtml(message.text || '')}</div>${messageImages(message)}</article>`;
  }).join('');
  $$('[data-message-image]').forEach(button => { button.onclick = () => {
    $('#attachmentPreviewImage').src = button.dataset.messageImage;
    $('#attachmentPreviewImage').alt = button.dataset.imageName;
    $('#attachmentPreviewCaption').textContent = button.dataset.imageName;
    showDialog('#attachmentPreviewDialog');
  }; });
  if (atBottom) container.scrollTop = container.scrollHeight;
  $('#newMessagesButton').hidden = atBottom || !messages.length;
}

function renderTask() {
  const groups = draftImageGroups();
  const groupImageIds = new Set(groups.flatMap(group => group.referenceIds));
  const task = state.taskSubmitting ? { intent: state.submitIntent, startedAt: state.submittedAt, status: 'starting' } : state.referencesFresh && !localBusy() ? null : state.project?.task;
  const feedback = describeTask({ task: state.submissionError ? { status: 'failed' } : task,
    submitting: state.taskSubmitting || state.serverCreating, stopping: state.stoppingTaskId === task?.id,
    awaitingApproval: state.approvals.size > 0, connected: state.bridge.connected && state.streamConnected,
    pendingRevision: Boolean(state.project?.pendingRevisionId), referenceCount: selectedReferences().length,
    uploading: state.uploading, activity: state.activity });
  const busy = localBusy();
  $('.task-card').dataset.tone = feedback.tone;
  $('.task-card').dataset.phase = feedback.phase;
  $('#taskTitle').textContent = feedback.title;
  $('#taskDescription').textContent = state.submissionError || (feedback.phase === 'failed' && task?.error ? String(task.error).slice(0, 240) : feedback.description);
  $('#taskActivity').textContent = ['working', 'generating'].includes(feedback.phase) && state.activity && state.activity !== feedback.description ? state.activity : '';
  $('#taskNotice').hidden = feedback.phase === 'idle' || feedback.phase === 'ready';
  $('.task-steps').hidden = !(task?.intent === 'generate' && (feedback.busy || feedback.phase === 'completed'));
  const stage = feedback.phase === 'submitting' || task?.status === 'starting' ? 0 : feedback.phase === 'validating' ? 2 : feedback.phase === 'completed' ? 3 : 1;
  $$('[data-step]').forEach((node, index) => { node.classList.toggle('active', index === stage); node.classList.toggle('done', index < stage); });
  $('#sendButton').hidden = busy;
  $('#sendButton').disabled = !state.project || busy || viewingHistory() || state.uploading || (!$('#promptInput').value.trim() && !groups.length);
  $('#stopButton').hidden = !busy;
  for (const id of ['stopButton', 'taskCardStop', 'overlayStopButton']) {
    const button = $(`#${id}`);
    button.disabled = !feedback.canStop;
    button.textContent = feedback.phase === 'stopping' ? '正在停止…' : '停止任务';
    if (id !== 'stopButton') button.hidden = !feedback.canStop && feedback.phase !== 'stopping';
  }
  $('#generateButton').disabled = !state.project || busy || viewingHistory() || state.uploading || !selectedReferences().length;
  $('#generateButton').textContent = state.uploading ? '正在上传…' : busy && task?.intent === 'generate' ? '建模进行中…' : '开始建模';
  $('#referenceHint').textContent = viewingHistory() ? '返回当前版本后可继续建模。' : state.uploading ? '正在上传图片…' : state.project?.references?.length && !selectedReferences().length ? '请选用至少一张参考图。' : '';
  $('#uploadButton').disabled = busy || state.uploading;
  const emptyUpload = $('#emptyUpload'); if (emptyUpload) emptyUpload.disabled = busy || state.uploading;
  const addMore = $('#addMoreReferences'); if (addMore) addMore.disabled = busy || state.uploading;
  $('#selectAllReferences').disabled = busy || state.uploading || !state.project?.references?.length;
  $('#clearReferenceSelection').disabled = busy || state.uploading || !state.referenceIds.size;
  $$('[data-reference], [data-remove-reference]').forEach(button => { button.disabled = busy || state.uploading; });
  $('#projectSelect').disabled = state.taskSubmitting || state.uploading;
  $('#newProject').disabled = state.taskSubmitting || state.uploading;
  $('#promptInput').disabled = state.taskSubmitting;
  $('#includedReferenceCount').textContent = `(${selectedReferences().length})`;
  $('#includeReferenceLabel').hidden = !groups.length;
  $('#includeProjectReferences').disabled = busy || state.uploading || viewingHistory();
  $('#conversationImageCount').textContent = groups.length ? `${groups.length} 组 · ${groupImageIds.size} 张` : '';
  conversationImages.refresh();
  const showCreation = feedback.overlay && !viewingHistory();
  $('#creationOverlay').hidden = !showCreation;
  $('.stage').classList.toggle('is-creating', showCreation);
  $('#viewportMount').inert = showCreation;
  $('#resetViewButton').disabled = !state.ready || showCreation;
  $('#creationOverlay').dataset.phase = feedback.phase;
  $('#creationActivity').textContent = ({ submitting: '准备中', validating: '正在载入预览', approval: '等待确认', stopping: '正在停止', disconnected: '等待恢复连接' })[feedback.phase] || '正在创作';
  $('#overlayApprovalButton').hidden = feedback.phase !== 'approval';
  creationParticles.setActive(showCreation);
  renderDisplaySettings();
  updateElapsed();
  renderVersions();
}

function updateElapsed() {
  const task = state.project?.task;
  const startedAt = state.taskSubmitting ? state.submittedAt : task?.startedAt;
  const endedAt = state.taskSubmitting || isBusy(task) ? null : task?.completedAt;
  const elapsed = state.referencesFresh && !localBusy() ? '' : startedAt && (state.taskSubmitting || isBusy(task) || endedAt) ? elapsedLabel(startedAt, endedAt) : '';
  $('#taskElapsed').textContent = elapsed;
  $('#creationElapsed').textContent = elapsed ? `已用时 ${elapsed}` : '';
}

function renderBridge() {
  const bridge = state.bridge;
  $('#connectButton').classList.toggle('connected', bridge.connected);
  $('#connectionLabel').textContent = bridge.connected ? 'Codex 已连接' : '连接 Codex';
  const models = bridge.models || [];
  const previous = $('#modelSelect').value || state.modelChoice;
  $('#modelSelect').innerHTML = '<option value="">本地默认模型</option>' + models.map(model => `<option value="${escapeHtml(model.model || model.id)}">${escapeHtml(model.displayName || model.id)}</option>`).join('');
  if ([...$('#modelSelect').options].some(option => option.value === previous)) $('#modelSelect').value = previous;
  selectMenus.get('modelSelect').refresh();
  const accountLabel = bridge.account?.type === 'chatgpt' ? 'ChatGPT' : bridge.account?.type === 'apiKey' ? 'API 登录' : bridge.account?.type || '使用本地 CLI 登录';
  $('#connectDetails').innerHTML = `<div class="connection-state ${bridge.connected ? 'connected' : ''}"><span class="status-dot"></span><div><strong>${bridge.connected ? '本地 Codex 已连接' : '等待连接本地 Codex CLI'}</strong><small>通过本机连接程序与 Codex app-server 通信</small></div></div>${bridge.error ? `<div class="connection-error">${escapeHtml(bridge.error)}</div>` : ''}<div class="connection-detail"><span>登录方式</span><strong>${escapeHtml(accountLabel)}${bridge.account?.planType ? ` · ${escapeHtml(bridge.account.planType)}` : ''}</strong></div><div class="connection-detail"><span>可选模型</span><strong>${models.length ? `${models.length} 个模型` : '连接后读取'}</strong></div><div class="connection-detail"><span>工作范围</span><strong>当前项目目录</strong></div><p class="modal-copy" style="margin-top:20px">首次使用时，请在电脑终端运行 <code>codex login</code> 完成登录。工作台使用现有登录，需要许可的操作会显示在创作助手中。</p><div class="code-note"><span>如果还没有安装 Codex CLI</span><code>npm install -g @openai/codex<br>codex login</code></div>`;
  $('#retryConnect').innerHTML = `${bridge.connected ? '重新检查连接' : '连接本地 CLI'} <span>↗</span>`;
  renderTask();
}

function loadModel(project, modelKey, revision = null) {
  state.modelKey = modelKey;
  state.displayRevisionId = revision?.id || project.pendingRevisionId || project.headId;
  state.displayOverrides = structuredClone(revision?.overrides || project.overrides || {});
  state.ready = false;
  state.hasMeshes = false; state.canExplode = false; state.hasAnimation = false; state.toggles.explode = false;
  renderDisplaySettings();
  state.parts = [];
  state.selection = null;
  $('#partSearch').value = '';
  for (const entry of pendingRpc.values()) { clearTimeout(entry.timer); entry.reject(new Error('视口已切换，请重试')); }
  pendingRpc.clear();
  renderParts();
  renderSelection();
  $('#geometryStats').replaceChildren();
  $('.stage').classList.toggle('is-loading', Boolean(project.modelUrl));
  for (const id of ['exportButton', 'resetViewButton', 'cameraViewSelect', 'wireButton', 'gridButton', 'animateButton', 'screenshotButton']) $(`#${id}`).disabled = true;
  if (!project.modelUrl) {
    state.iframe = null;
    $('#viewportMount').innerHTML = '<div class="stage-placeholder"><span class="large-cube">◇</span><p>上传参考图，开始创造你的模型</p></div>';
    return;
  }
  const frame = document.createElement('iframe');
  frame.title = `${project.name}${revision ? ` · V${revisionNumber(revision.id)} 历史版本` : ''} · 三维视口`;
  frame.setAttribute('sandbox', 'allow-scripts allow-downloads');
  frame.src = `/studio-viewer/preview.html?model=${encodeURIComponent(project.modelUrl)}&background=${state.background}`;
  frame.addEventListener('load', () => { if (state.iframe === frame) viewerCommand('background', { value: state.background }); });
  state.iframe = frame;
  $('#viewportMount').replaceChildren(frame);
}

function viewerCommand(type, data = {}) {
  if (!state.iframe) return;
  state.iframe.contentWindow.postMessage({ source: 'model-studio', type, ...data }, '*');
}

function syncCameraSelector() {
  const select = $('#cameraViewSelect');
  const view = state.camera?.view || 'perspective';
  const preset = [...select.options].find(option => option.value === view && !option.disabled && !option.hidden);
  const custom = select.querySelector('[value="custom"]');
  custom.hidden = Boolean(preset);
  select.value = preset ? view : 'custom';
  selectMenus.get('cameraViewSelect').refresh();
}

function renderAnimationControl(available) {
  state.hasAnimation = Boolean(available);
  const button = $('#animateButton');
  button.disabled = !available;
  if (!available) state.toggles.animate = false;
  const playing = state.toggles.animate;
  button.setAttribute('aria-pressed', String(playing));
  button.title = !available ? '此模型暂无动画' : playing ? '暂停模型动画' : '播放模型动画';
  button.setAttribute('aria-label', button.title);
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${playing ? '<path d="M8 5v14M16 5v14"/>' : '<path d="m8 4.5 12 7.5-12 7.5v-15Z"/>'}</svg>`;
}

function viewerRpc(type, data = {}, timeout = 15000) {
  if (!state.ready) return Promise.reject(new Error('请等待模型完成载入'));
  return new Promise((resolve, reject) => {
    const requestId = `ui-${++rpcId}`;
    const timer = setTimeout(() => { pendingRpc.delete(requestId); reject(new Error('视口操作超时，请重试')); }, timeout);
    pendingRpc.set(requestId, { resolve, reject, timer });
    viewerCommand(type, { ...data, requestId });
  });
}

async function validateRevision(valid, error) {
  const project = state.project;
  if (viewingHistory() || !project?.pendingRevisionId || state.displayRevisionId !== project.pendingRevisionId) return;
  const key = `${project.id}:${project.pendingRevisionId}`;
  if (validationKey === key) return;
  validationKey = key;
  try {
    const result = await api(projectUrl('/validate', project), { method: 'POST', body: { revisionId: project.pendingRevisionId, valid, ...(error ? { error } : {}) } });
    if (state.project?.id === project.id) setProject(result);
    if (!valid) toast('新版本未通过预览校验，已保留上一个可用版本。', true);
  } catch (failure) { validationKey = ''; toast(failure.message, true); }
}

window.addEventListener('message', event => {
  if (!state.iframe || event.source !== state.iframe.contentWindow || event.data?.source !== 'model-studio-viewport') return;
  const data = event.data;
  if (data.requestId && pendingRpc.has(data.requestId)) {
    const request = pendingRpc.get(data.requestId);
    pendingRpc.delete(data.requestId);
    clearTimeout(request.timer);
    if (data.type === 'error') request.reject(new Error(data.message));
    else request.resolve(data);
    return;
  }
  if (data.type === 'ready') {
    state.ready = true;
    state.canExplode = data.canExplode === true;
    state.hasMeshes = Number(data.stats?.meshes) > 0;
    $('.stage').classList.remove('is-loading');
    state.parts = data.parts || [];
    state.camera = data.camera;
    // A single-category model (for example, a lamp) should expose its parts immediately.
    const categories = [...new Set(state.parts.map(part => part.category || 'details'))];
    if (categories.length === 1) state.openCategories.add(categories[0]);
    for (const [view, category] of [['cockpit', 'cockpit'], ['engine', 'engines']]) {
      const option = $(`#cameraViewSelect option[value="${view}"]`);
      option.hidden = option.disabled = !categories.includes(category);
    }
    syncCameraSelector();
    $('#geometryStats').innerHTML = `<span class="geometry-stat"><span>三角面</span><b>${Number(data.stats?.triangles || 0).toLocaleString()}</b></span><span class="geometry-stat"><span>顶点</span><b>${Number(data.stats?.vertices || 0).toLocaleString()}</b></span>`;
    for (const id of ['exportButton', 'resetViewButton', 'cameraViewSelect', 'wireButton', 'gridButton', 'screenshotButton']) $(`#${id}`).disabled = false;
    renderAnimationControl(Boolean(data.animationCount));
    for (const [partId, patch] of Object.entries(state.displayOverrides)) if (state.parts.some(part => part.id === partId)) viewerCommand('setPart', { partId, ...patch });
    viewerCommand('background', { value: state.background });
    for (const [type, value] of Object.entries(state.toggles)) viewerCommand(type, { value });
    renderParts();
    renderSelection();
    renderTask();
    void validateRevision(true);
  } else if (data.type === 'displayState') {
    if (typeof data.clay === 'boolean') state.toggles.clay = data.clay;
    if (typeof data.exploded === 'boolean') state.toggles.explode = data.exploded;
    if (typeof data.animate === 'boolean') state.toggles.animate = data.animate;
    renderAnimationControl(state.hasAnimation);
    renderDisplaySettings();
  } else if (data.type === 'selection') {
    state.selection = data.selection || null;
    state.camera = data.camera || state.camera;
    if (state.selection) {
      const category = state.selection.category || 'details';
      state.openCategories.add(category);
      const siblings = state.parts.filter(part => (part.category || 'details') === category);
      if (siblings.findIndex(part => part.id === state.selection.partId) >= partPreviewCount) state.expandedPartLists.add(category);
    }
    renderSelection();
    renderParts();
  } else if (data.type === 'partChanged') {
    state.parts = data.parts || state.parts;
    if (data.selection) state.selection = data.selection;
    renderParts();
    renderSelection();
  } else if (data.type === 'camera') {
    state.camera = { position: data.position, target: data.target, up: data.up, view: data.view };
    syncCameraSelector();
  } else if (data.type === 'error') {
    toast(data.message || '模型无法预览', true);
    if (!state.ready) {
      $('.stage').classList.remove('is-loading');
      $('#geometryStats').innerHTML = '<span>模型预览失败</span>';
      void validateRevision(false, data.message);
    }
  }
});

function renderParts() {
  const filter = $('#partSearch').value.trim().toLowerCase();
  const parts = state.parts.filter(part => !filter || `${part.name} ${partLabel(part)} ${partDetail(part)} ${categoryLabels[part.category] || part.category || ''}`.toLowerCase().includes(filter));
  const tree = $('#partTree');
  const scrollTop = tree.scrollTop;
  const active = tree.contains(document.activeElement) ? document.activeElement : null;
  const focusPart = active?.dataset.part;
  const focusVisibility = active?.dataset.visibility;
  const partMap = new Map(state.parts.map(part => [part.id, part]));
  const depthOf = part => {
    let depth = 0;
    let parent = partMap.get(part.parentId);
    while (parent && depth < 2) { depth++; parent = partMap.get(parent.parentId); }
    return depth;
  };
  $('#partCount').textContent = filter ? `${parts.length} / ${state.parts.length} 个部件` : `${state.parts.length} 个部件`;
  const anyOpen = state.parts.some(part => state.openCategories.has(part.category || 'details'));
  const collapse = $('#collapseParts');
  collapse.disabled = Boolean(filter) || !state.parts.length;
  collapse.title = filter ? '清空搜索后可收起分组' : anyOpen ? '收起全部分组' : '展开全部分组';
  collapse.setAttribute('aria-label', collapse.title);
  collapse.innerHTML = inspectorIcon(anyOpen ? 'collapse' : 'expand');
  if (!parts.length) {
    tree.innerHTML = `<p class="empty-small">${filter ? '没有匹配的部件，试试其他关键词。' : state.ready ? '这个模型没有可编辑部件。' : '模型载入后，部件将显示在这里。'}</p>`;
    return;
  }
  const categories = [...new Set([...categoryOrder, ...parts.map(part => part.category || 'details')])];
  tree.innerHTML = categories.map(category => {
    const children = parts.filter(part => (part.category || 'details') === category);
    if (!children.length) return '';
    const open = Boolean(filter) || state.openCategories.has(category);
    const expanded = state.expandedPartLists.has(category);
    const limit = filter ? 30 : partPreviewCount;
    const visible = expanded ? children : children.slice(0, limit);
    const selectedId = state.selection?.partId || state.selection?.id;
    return `<div class="part-group ${open ? 'open' : ''}"><button class="group-toggle" data-category="${escapeHtml(category)}" aria-expanded="${open}" ${filter ? 'disabled' : ''}><span class="chevron">${inspectorIcon('chevron')}</span><span class="group-title">${escapeHtml(categoryLabels[category] || category)}</span><span class="group-count">${children.length}</span></button><div class="part-rows">${visible.map(part => {
      const label = escapeHtml(partLabel(part));
      const selected = selectedId === part.id;
      const hidden = part.visible === false;
      return `<div class="part-entry ${selected ? 'selected' : ''} ${hidden ? 'is-hidden' : ''}" style="--part-depth:${depthOf(part)}"><button class="part-row" data-part="${escapeHtml(part.id)}" title="${escapeHtml(part.name)}" aria-pressed="${selected}"><span class="part-copy"><span class="part-name">${label}</span><span class="part-detail">${escapeHtml(partDetail(part))}${part.kind === 'group' && partDetail(part) !== '部件分组' ? ' · 分组' : ''}</span></span></button><button class="part-visibility" data-visibility="${escapeHtml(part.id)}" aria-label="${hidden ? '显示' : '隐藏'} ${label}" title="${hidden ? '显示' : '隐藏'}部件" aria-pressed="${!hidden}">${inspectorIcon(hidden ? 'eyeOff' : 'eye')}</button></div>`;
    }).join('')}${children.length > limit ? `<button class="tree-more" data-more="${escapeHtml(category)}" aria-expanded="${expanded}">${expanded ? '收起部件列表' : `展开其余 ${children.length - visible.length} 个部件`}</button>` : ''}</div></div>`;
  }).join('');
  tree.scrollTop = scrollTop;
  if (focusPart || focusVisibility) {
    const attribute = focusPart ? 'part' : 'visibility';
    $$(`[data-${attribute}]`).find(button => button.dataset[attribute] === (focusPart || focusVisibility))?.focus({ preventScroll: true });
  }
  $$('[data-category]').forEach(button => { button.onclick = () => {
    const category = button.dataset.category;
    if (state.openCategories.has(category)) state.openCategories.delete(category); else state.openCategories.add(category);
    renderParts();
    $$('[data-category]').find(item => item.dataset.category === category)?.focus({ preventScroll: true });
  }; });
  $$('[data-more]').forEach(button => { button.onclick = () => {
    const category = button.dataset.more;
    if (state.expandedPartLists.has(category)) state.expandedPartLists.delete(category); else state.expandedPartLists.add(category);
    renderParts();
    $$('[data-more]').find(item => item.dataset.more === category)?.focus({ preventScroll: true });
  }; });
  $$('[data-part]').forEach(button => { button.onclick = () => viewerCommand('select', { partId: button.dataset.part }); });
  $$('[data-visibility]').forEach(button => { button.onclick = async () => {
    const part = partMap.get(button.dataset.visibility);
    if (!part) return;
    const updateKey = `${state.project.id}:${part.id}`;
    if (pendingPartUpdates.has(updateKey)) return;
    pendingPartUpdates.add(updateKey);
    button.setAttribute('aria-busy', 'true');
    try { await savePartOverride(part.id, { visible: part.visible === false }); }
    finally { pendingPartUpdates.delete(updateKey); button.removeAttribute('aria-busy'); }
  }; });
  if (viewingHistory()) $$('[data-visibility]').forEach(button => { button.disabled = true; button.title = '历史版本为只读预览'; });
}

function renderSelection() {
  const part = state.selection;
  const selectedContext = $('#selectionContext');
  selectedContext.hidden = !part || viewingHistory();
  if (part) {
    selectedContext.innerHTML = `<span title="${escapeHtml(part.name)}">${escapeHtml(partLabel(part))}</span><button aria-label="取消部件选择" title="取消选择">×</button>`;
    selectedContext.querySelector('button').onclick = () => viewerCommand('select', { partId: null });
  }
  if (!part) {
    $('#selectionSummary').innerHTML = '<div class="selection-empty"><strong>未选择部件</strong><p>在模型或列表中选择部件。</p></div>';
    $('#properties').innerHTML = '<div class="empty-small property-empty">选择一个部件</div>';
    return;
  }
  $('#selectionSummary').innerHTML = `<div class="selection-eyebrow">当前选中</div><div class="selection-summary-row"><div class="selection-summary-copy"><strong>${escapeHtml(partLabel(part))}</strong><p>${escapeHtml(partDetail(part))}${part.visible === false ? ' · 已隐藏' : ''}</p></div><button id="selectionProperties" class="selection-properties">查看属性</button></div>`;
  $('#selectionProperties').onclick = () => setTab('properties');
  const position = part.position || [0, 0, 0];
  const color = /^#[0-9a-f]{6}$/i.test(part.color || '') ? part.color.toUpperCase() : null;
  const colorUnavailable = part.colorState === 'unavailable';
  $('#properties').innerHTML = `<div class="property-header"><h2>${escapeHtml(partLabel(part))}</h2></div>
    <section class="property-section property-appearance">
      <div class="property-row"><label for="partVisible">显示</label><label class="property-switch"><input type="checkbox" id="partVisible" role="switch" aria-label="显示部件" ${part.visible !== false ? 'checked' : ''}><span class="property-switch-track" aria-hidden="true"></span></label></div>
      <div class="property-row"><label for="partColor">颜色</label><label class="property-color-control" for="partColor"><span class="property-color-swatch${colorUnavailable ? ' is-unavailable' : color ? '' : ' is-mixed'}"${color ? ` style="--part-color:${color}"` : ''} aria-hidden="true"></span><span class="color-value">${color || (colorUnavailable ? '无颜色' : '混合')}</span><svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true"><path d="m5 6.5 3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg><input type="color" id="partColor" value="${color || '#ffffff'}" aria-label="部件颜色" ${colorUnavailable ? 'disabled' : ''}></label></div>
    </section>
    <section class="property-section property-position"><h3>位置</h3><div class="position-inputs">${['X', 'Y', 'Z'].map((axis, index) => `<label><span class="position-axis axis-${axis.toLowerCase()}">${axis}</span><input type="number" step="0.01" value="${Number(position[index]).toFixed(3)}" id="partPosition${index}" aria-label="${axis} 轴位置"></label>`).join('')}</div><div class="property-position-actions"><button id="applyPosition" class="apply-position">应用位置</button></div></section>
    <div class="property-conversation"><button id="askAboutPart" class="property-ask"><svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true"><path d="M5 15.5 2.75 17v-4.5A3 3 0 0 1 2 10.5V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v6.5a3 3 0 0 1-3 3H5Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M6 7.5h8M6 11h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><span>对话修改</span></button></div>`;
  $('#partVisible').onchange = event => void saveOverride({ visible: event.target.checked });
  $('#partColor').onchange = event => void saveOverride({ color: event.target.value });
  const applyPosition = () => {
    const position = [0, 1, 2].map(index => $(`#partPosition${index}`).valueAsNumber);
    if (!position.every(Number.isFinite)) return toast('请输入有效的坐标数值', true);
    void saveOverride({ position });
  };
  $('#applyPosition').onclick = applyPosition;
  $$('#properties .position-inputs input').forEach(input => { input.onkeydown = event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    applyPosition();
  }; });
  $('#askAboutPart').onclick = () => {
    if (viewingHistory()) return;
    setPanelOpen('left', true);
    $('#promptInput').focus();
  };
  if (viewingHistory()) {
    $('#properties').insertAdjacentHTML('afterbegin', '<p class="history-readonly-note">历史版本 · 只读</p>');
    $$('#properties input, #properties button').forEach(control => { control.disabled = true; });
  }
}

async function saveOverride(patch) {
  const partId = state.selection?.partId || state.selection?.id;
  return savePartOverride(partId, patch);
}

async function savePartOverride(partId, patch) {
  if (!partId) return;
  if (viewingHistory()) return toast('历史版本为只读预览，请先返回当前版本。');
  const projectId = state.project.id;
  const frame = state.iframe;
  state.savingParts++; renderVersions();
  try {
    const result = await api(projectUrl('/overrides'), { method: 'POST', body: { partId, patch } });
    if (state.project?.id !== projectId) return;
    setProject(result, { keepViewport: frame === state.iframe });
    if (frame === state.iframe && !viewingHistory()) {
      state.displayRevisionId = result.pendingRevisionId || result.headId;
      state.displayOverrides = structuredClone(result.overrides || {});
      viewerCommand('setPart', { partId, ...patch });
    }
  } catch (error) { toast(error.message, true); renderSelection(); renderParts(); }
  finally { state.savingParts--; renderVersions(); }
}

function renderVersions() {
  const versions = [...(state.project?.versions || [])].reverse();
  $('#versionCount').textContent = `共 ${versions.length} 个版本`;
  const canPreview = !state.project?.pendingRevisionId && !state.savingParts && !state.restoringVersion && !state.taskSubmitting && !state.uploading;
  const canRestore = !localBusy() && !state.savingParts && !state.restoringVersion && !state.uploading;
  $('#versionStatusNote').textContent = state.project?.pendingRevisionId ? '新版本正在校验，完成后可预览。' : localBusy() ? '任务进行中，暂不可恢复版本。' : '';
  const tree = $('#versions'), scrollPane = $('#versionsPane'), scrollTop = scrollPane.scrollTop;
  const focusedId = tree.contains(document.activeElement) ? document.activeElement.dataset.preview || document.activeElement.dataset.restore : null;
  const focusedAction = document.activeElement?.dataset.preview ? 'preview' : 'restore';
  tree.innerHTML = versions.length ? versions.map(version => {
    const previewing = state.previewRevision?.id === version.id;
    const loading = state.previewLoadingId === version.id;
    return `<article class="version-card ${version.isHead ? 'is-head' : ''} ${previewing ? 'is-previewing' : ''} ${version.status === 'invalid' ? 'invalid' : ''}"><div class="version-top"><span class="version-number">V${revisionNumber(version.id)}</span><strong>${escapeHtml(version.label || '模型版本')}</strong></div><div class="version-meta"><time>${escapeHtml(timeLabel(version.createdAt))} ${version.status === 'pending' ? '· 正在校验' : version.status === 'invalid' ? '· 校验未通过' : ''}</time><div class="version-badges">${previewing ? '<span class="preview-label">预览中</span>' : ''}</div></div>${version.status === 'valid' ? `<div class="version-actions"><button class="version-preview-button" data-preview="${escapeHtml(version.id)}" ${!canPreview || loading || previewing || (version.isHead && !state.previewRevision) ? 'disabled' : ''}>${loading ? '正在载入…' : previewing ? '正在预览' : version.isHead ? (state.previewRevision ? '返回当前版本' : '当前展示') : '预览此版本'}</button>${!version.isHead ? `<button data-restore="${escapeHtml(version.id)}" ${canRestore ? '' : 'disabled'} title="${canRestore ? '将此版本设为当前工作版本' : '请等待当前任务或操作结束'}">恢复此版本</button>` : ''}</div>` : ''}</article>`;
  }).join('') : '<p class="empty-small">模型修改完成后，版本将显示在这里。</p>';
  scrollPane.scrollTop = scrollTop;
  $$('[data-preview]').forEach(button => { button.onclick = () => {
    if (button.dataset.preview === state.project.headId) returnToCurrent();
    else void previewVersion(button.dataset.preview);
  }; });
  $$('[data-restore]').forEach(button => { button.onclick = () => void restoreVersion(button.dataset.restore); });
  if (focusedId) $$(`[data-${focusedAction}]`).find(button => !button.disabled && button.dataset[focusedAction] === focusedId)?.focus({ preventScroll: true });
}

function renderPreviewBanner() {
  const revision = state.previewRevision;
  $('#versionPreviewBanner').hidden = !revision;
  $('.stage').classList.toggle('is-version-preview', Boolean(revision));
  if (revision) {
    $('#previewVersionLabel').textContent = `V${revisionNumber(revision.id)} · ${revision.label || '模型版本'}`;
    $('#previewVersionLabel').title = revision.label || '模型版本';
    $('#previewVersionHint').textContent = `${timeLabel(revision.createdAt)} · 当前工作版本未改变`;
  }
  $('#exportButtonLabel').textContent = revision ? `导出 V${revisionNumber(revision.id)}` : '导出 GLB';
}

async function previewVersion(revisionId) {
  const project = state.project;
  if (!project || project.pendingRevisionId || state.restoringVersion || state.savingParts || state.taskSubmitting || state.uploading) return;
  const version = project.versions.find(item => item.id === revisionId && item.status === 'valid');
  if (!version) return toast('该版本尚不可预览。', true);
  const request = ++state.previewRequest;
  state.previewLoadingId = revisionId;
  renderTask(); renderSelection(); renderParts();
  try {
    let metadata;
    if (state.revisionPreviewApi) {
      metadata = await api(projectUrl(`/versions/${encodeURIComponent(revisionId)}`, project));
    } else {
      // Compatibility with an already-running local Agent: immutable snapshots
      // can be browsed without restarting its server or interrupting its task.
      const key = `${project.id}:${revisionId}`;
      metadata = revisionCache.get(key);
      if (!metadata) {
        try { metadata = JSON.parse(sessionStorage.getItem(`studio-revision:${key}`)); } catch { /* Fall through to the immutable manifest. */ }
      }
      if (!metadata) {
        const response = await fetch(`/studio-web/revision-previews/${encodeURIComponent(project.id)}/${encodeURIComponent(revisionId)}.json`);
        if (!response.ok) throw new Error('历史属性快照暂不可用，请等待当前任务结束后重新打开工作台。');
        metadata = await response.json();
      }
    }
    if (request !== state.previewRequest || state.project?.id !== project.id) return;
    if (metadata?.id !== revisionId || !metadata.overrides || typeof metadata.overrides !== 'object' || Array.isArray(metadata.overrides)) throw new Error('历史属性快照无效。');
    const url = new URL(project.modelUrl, location.href);
    url.searchParams.set('version', revisionId);
    const revision = { ...version, overrides: metadata.overrides, modelUrl: url.pathname + url.search };
    rememberRevision(project.id, revisionId, revision.overrides);
    state.previewRevision = revision; state.previewLoadingId = null;
    renderPreviewBanner(); renderTask();
    loadModel({ ...state.project, modelUrl: revision.modelUrl }, `${project.id}:preview:${revisionId}`, revision);
  } catch (error) {
    if (request === state.previewRequest && state.project?.id === project.id) {
      state.previewLoadingId = null; renderTask(); renderSelection(); renderParts(); toast(error.message, true);
    }
  }
}

function returnToCurrent() {
  state.previewRequest++; state.previewLoadingId = null; state.previewRevision = null;
  renderPreviewBanner(); renderTask();
  if (state.project) loadModel(state.project, `${state.project.id}:${state.project.modelUrl}`);
}

async function restoreVersion(revisionId) {
  if (localBusy() || state.restoringVersion || state.savingParts || state.uploading) return toast('请等待当前任务或操作结束后再恢复版本。');
  const project = state.project;
  const version = project?.versions.find(item => item.id === revisionId && item.status === 'valid');
  if (!version) return;
  state.restoringVersion = true; state.previewRequest++; state.previewLoadingId = null; renderVersions();
  try {
    const result = await api(projectUrl(`/versions/${encodeURIComponent(revisionId)}/restore`, project), { method: 'POST', body: {} });
    if (state.project?.id === project.id) setProject(result, { forceLoad: true });
    toast('已恢复为当前工作版本');
  } catch (error) { toast(error.message, true); }
  finally { state.restoringVersion = false; renderVersions(); }
}

$('#returnCurrentButton').onclick = returnToCurrent;

function renderApprovals() {
  const approval = [...state.approvals.values()][0];
  const panel = $('#approvalPanel');
  panel.hidden = !approval;
  if (!approval) return;
  panel.innerHTML = `<h3>需要你的许可 · ${approval.kind === 'file' ? '文件修改' : '命令执行'}</h3><p>${escapeHtml(approval.reason)}</p>${approval.command ? `<pre>${escapeHtml(approval.command)}</pre>` : ''}${approval.paths?.length ? `<pre>${escapeHtml(approval.paths.join('\n'))}</pre>` : ''}${approval.grantRoot ? `<p>写入目录：${escapeHtml(approval.grantRoot)}</p>` : ''}${approval.cwd ? `<p>工作目录：${escapeHtml(approval.cwd)}</p>` : ''}<div class="approval-actions"><button data-decision="accept">允许这次</button><button data-decision="decline">拒绝</button><button data-decision="cancel">停止任务</button></div>`;
  $$('[data-decision]').forEach(button => { button.onclick = async () => {
    $$('[data-decision]').forEach(item => { item.disabled = true; });
    try {
      await api(`/api/approvals/${encodeURIComponent(approval.requestId)}`, { method: 'POST', body: { decision: button.dataset.decision } });
      state.approvals.delete(approval.requestId);
      state.approvalSnapshot = state.approvalSnapshot.filter(item => item.requestId !== approval.requestId);
      renderApprovals(); renderTask();
    } catch (error) { toast(error.message, true); renderApprovals(); renderTask(); }
  }; });
}

function syncApprovals() {
  state.approvals = new Map(state.approvalSnapshot.filter(item => item.projectId === state.project?.id).map(item => [item.requestId, item]));
  renderApprovals();
}

async function connect() {
  $('#retryConnect').disabled = true;
  $('#retryConnect').textContent = '正在连接…';
  try {
    state.bridge = await api('/api/connect', { method: 'POST', body: {} });
    renderBridge();
    if (state.bridge.connected) toast('本地 Codex 已连接');
  } catch (error) { state.bridge = { ...state.bridge, error: error.message }; renderBridge(); }
  finally { $('#retryConnect').disabled = false; }
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
const safeFilename = name => String(name || 'model').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100);

async function copyProjectPath() {
  const value = state.project?.workspacePath;
  if (!value) return toast('项目目录尚未就绪', true);
  try { await navigator.clipboard.writeText(value); toast('已复制项目目录'); }
  catch { toast('无法自动复制，可在“本地项目”窗口选中目录手动复制。', true); $('#workspacePath').textContent = value; showDialog('#projectInfoDialog'); }
}

$('#projectSelect').onchange = event => selectProject(event.target.value).catch(error => toast(error.message, true));
$('#newProject').onclick = () => { showDialog('#newProjectDialog'); $('#projectNameInput').focus(); };
$('#newProjectForm').onsubmit = async event => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type=submit]');
  button.disabled = true;
  try {
    const project = await api('/api/projects', { method: 'POST', body: { name: $('#projectNameInput').value.trim(), template: $('#templateSelect').value } });
    state.loadingProject++;
    setProject(project);
    sessionStorage.setItem('studio-active-project', project.id);
    $('#newProjectDialog').close();
    $('#projectNameInput').value = '';
    toast('新项目已创建');
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
};
$('#connectButton').onclick = () => { renderBridge(); showDialog('#connectDialog'); };
$('#retryConnect').onclick = connect;
$('#skillButton').onclick = () => showDialog('#skillDialog');
$('#copyWorkspaceButton').onclick = copyProjectPath;
$('#copyPathButton').onclick = copyProjectPath;
$('#projectInfoButton').onclick = () => showDialog('#projectInfoDialog');
$$('[data-close-dialog]').forEach(button => { button.onclick = () => button.closest('dialog').close(); });
$$('dialog').forEach(dialog => { dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
}); });
$('#modelSelect').onchange = event => { state.modelChoice = event.target.value; };
$('#uploadButton').onclick = () => $('#referenceInput').click();
$('#referenceInput').onchange = async event => {
  const files = [...event.target.files];
  event.target.value = '';
  if (!files.length) return;
  try { await persistImages(files, true); } catch (error) { toast(error.message, true); }
};

async function persistImages(files, selectNew) {
  const project = state.project;
  if (!project) throw new Error('请先选择一个项目。');
  if (localBusy() || state.uploading || state.restoringVersion) throw new Error('请等待当前任务或上传完成后再添加图片。');
  const incoming = Array.from(files);
  if (!incoming.length) return [];
  if ((project.references?.length || 0) + incoming.length > state.imageLimits.projectLibrary) throw new Error(`项目图库最多保存 ${state.imageLimits.projectLibrary} 张图片。`);
  if (selectNew && incoming.length > state.imageLimits.perTask) throw new Error(`一次最多选用 ${state.imageLimits.perTask} 张参考图，请分批添加。`);
  const accepted = incoming.map(file => {
    const extension = file.name.split('.').pop().toLowerCase();
    const type = file.type || ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }[extension]);
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) throw new Error(`${file.name}：请选择 PNG、JPEG 或 WebP 图片。`);
    if (!file.size || file.size > 12 * 1024 * 1024) throw new Error(`${file.name}：每张图片须大于 0 且不超过 12 MB。`);
    return { file, type };
  });
  state.uploading = true; state.submissionError = null;
  const uploaded = [], failures = [];
  renderTask(); renderReferences();
  try {
    for (const { file, type } of accepted) {
      if (state.project?.id !== project.id) break;
      try {
        const raw = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('图片读取失败')); reader.readAsDataURL(file); });
        const dataUrl = `data:${type};base64,${String(raw).split(',')[1]}`;
        const previousIds = new Set(state.project.references.map(reference => reference.id));
        const result = await api(projectUrl('/references', project), { method: 'POST', body: { name: file.name, dataUrl } });
        if (state.project?.id !== project.id) break;
        uploaded.push(...result.references.filter(reference => !previousIds.has(reference.id)));
        if (selectNew) { state.referenceIds = new Set(uploaded.map(reference => reference.id)); state.referencesFresh = true; }
        setProject(result);
      } catch (error) {
        failures.push(`${file.name}：${error.message}`);
      }
    }
    if (failures.length) {
      if (!uploaded.length) throw new Error(failures.join('\n'));
      toast(`已添加 ${uploaded.length} 张；${failures.length} 张未成功，请重新添加。\n${failures[0]}`, true);
    } else if (uploaded.length) toast(`已添加 ${uploaded.length} 张${selectNew ? '项目参考图' : '会话图片'}`);
    return uploaded;
  }
  finally { state.uploading = false; renderReferences(); renderTask(); }
}

$('#selectAllReferences').onclick = () => { state.referenceIds = new Set((state.project?.references || []).slice(0, state.imageLimits.perTask).map(reference => reference.id)); state.referencesFresh = true; renderReferences(); renderTask(); };
$('#clearReferenceSelection').onclick = () => { state.referenceIds.clear(); state.referencesFresh = true; renderReferences(); renderTask(); };
$('#includeProjectReferences').onchange = renderTask;
const hasDraggedFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files');
const referenceDropzone = $('#referenceDropzone');
for (const type of ['dragenter', 'dragover']) referenceDropzone.addEventListener(type, event => {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = localBusy() || state.uploading ? 'none' : 'copy';
  if (!localBusy() && !state.uploading) referenceDropzone.classList.add('is-dragover');
});
referenceDropzone.addEventListener('dragleave', event => { if (!referenceDropzone.contains(event.relatedTarget)) referenceDropzone.classList.remove('is-dragover'); });
referenceDropzone.addEventListener('drop', event => {
  if (!hasDraggedFiles(event)) return;
  event.preventDefault(); event.stopPropagation(); referenceDropzone.classList.remove('is-dragover');
  void persistImages(event.dataTransfer.files, true).catch(error => toast(error.message, true));
});
referenceDropzone.addEventListener('keydown', event => {
  if (event.target === referenceDropzone && ['Enter', ' '].includes(event.key)) { event.preventDefault(); if (!localBusy() && !state.uploading) $('#referenceInput').click(); }
});
window.addEventListener('dragover', event => { if (hasDraggedFiles(event)) event.preventDefault(); });
window.addEventListener('drop', event => { if (hasDraggedFiles(event)) event.preventDefault(); referenceDropzone.classList.remove('is-dragover'); });

async function submitTask(intent) {
  if (viewingHistory()) return toast('请先返回当前版本，再继续建模或对话。');
  if (state.restoringVersion || state.savingParts) return toast('请等待部件或版本保存完成。');
  const prompt = $('#promptInput').value.trim();
  const imageGroups = draftImageGroups();
  if (localBusy() || state.uploading || !state.project || state.serverCreating) return;
  if (intent === 'generate' && !selectedReferences().length) return toast('请先上传或选中参考图片。');
  if (intent !== 'generate' && !prompt && !imageGroups.length) return;
  if (imageGroups.length && !state.imageGroupsEnabled) return toast('连接程序尚未更新，请刷新工作台后再附加图片组。', true);
  const project = state.project;
  const referenceIds = intent === 'generate' || $('#includeProjectReferences').checked ? selectedReferences().map(reference => reference.id) : [];
  const allImageIds = new Set([...referenceIds, ...imageGroups.flatMap(group => group.referenceIds)]);
  if (allImageIds.size > state.imageLimits.perTask) return toast(`本轮共 ${allImageIds.size} 张图片，最多 ${state.imageLimits.perTask} 张。请减少图片，或取消“同时带上已选项目参考图”。`, true);
  state.taskSubmitting = true;
  state.submitIntent = intent; state.submittedAt = new Date().toISOString();
  state.referencesFresh = false;
  state.submissionError = null; state.activity = ''; state.lastActivityAt = null;
  state.liveMessages.clear();
  renderTask();
  try {
    let viewContext = intent === 'generate' ? null : state.camera;
    let selectedPart = intent === 'generate' ? null : state.selection;
    let screenshotDataUrl;
    if (state.ready && intent !== 'generate') {
      try {
        const view = await viewerRpc('requestState');
        viewContext = view.camera; selectedPart = view.selection;
        if (state.imageGroupsEnabled || referenceIds.length < 8) screenshotDataUrl = (await viewerRpc('screenshot')).dataUrl;
      } catch (error) { toast(`视口截图未附加：${error.message}`, true); }
    }
    const result = await api(projectUrl('/tasks', project), { method: 'POST', body: {
      intent, prompt, ...(state.modelChoice ? { model: state.modelChoice } : {}),
      ...(selectedPart ? { selectedPart } : {}), ...(viewContext ? { viewContext } : {}),
      ...(screenshotDataUrl ? { screenshotDataUrl } : {}), referenceIds, imageGroups,
    } });
    if (state.project?.id === project.id) {
      state.project.task = result.task;
      $('#promptInput').value = '';
      conversationImages.clear();
      const updated = await api(projectUrl('', project));
      if (state.project?.id === project.id) setProject(updated);
    }
  } catch (error) {
    if (state.project?.id === project.id) state.submissionError = error.message;
    toast(error.message, true);
  }
  finally { state.taskSubmitting = false; renderTask(); renderMessages(); }
}
$('#generateButton').onclick = () => void submitTask('generate');
$('#composer').onsubmit = event => {
  event.preventDefault();
  void submitTask('chat');
};
$('#promptInput').addEventListener('input', renderTask);
$('#promptInput').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); $('#composer').requestSubmit(); } });
async function stopTask() {
  const project = state.project, task = project?.task;
  if (!task || !isBusy(task) || state.stoppingTaskId === task.id || state.taskSubmitting) return;
  state.stoppingTaskId = task.id; renderTask();
  try { await api('/api/tasks/stop', { method: 'POST', body: { projectId: project.id, taskId: task.id } }); }
  catch (error) { state.stoppingTaskId = null; toast(error.message, true); renderTask(); }
}
for (const id of ['stopButton', 'taskCardStop', 'overlayStopButton']) $(`#${id}`).onclick = stopTask;
$('#overlayApprovalButton').onclick = () => {
  setPanelOpen('left', true);
  $('#approvalPanel').scrollIntoView({ block: 'nearest' });
  $('#approvalPanel button')?.focus();
};
$('#newMessagesButton').onclick = () => { $('#messages').scrollTop = $('#messages').scrollHeight; $('#newMessagesButton').hidden = true; };
$('#clearConversationButton').onclick = () => {
  if (!state.project || localBusy()) return;
  hiddenConversationIds.set(state.project.id, new Set(state.project.messages.map(message => message.id)));
  renderMessages();
  $('#restoreConversationButton').focus();
};
$('#restoreConversationButton').onclick = () => {
  hiddenConversationIds.delete(state.project?.id);
  renderMessages();
  $('#clearConversationButton').focus();
};
$('#messages').addEventListener('scroll', () => {
  const node = $('#messages');
  if (node.scrollHeight - node.scrollTop - node.clientHeight < 70) $('#newMessagesButton').hidden = true;
});
$('#cameraViewSelect').onchange = event => { if (state.ready) viewerCommand('view', { view: event.target.value }); };
$('#displaySettingsButton').onclick = () => setDisplaySettingsOpen($('#displaySettingsPanel').hidden, true);
$('#closeDisplaySettings').onclick = () => setDisplaySettingsOpen(false, true);
$$('.background-options [data-background]').forEach(button => { button.onclick = () => {
  state.background = button.dataset.background;
  renderDisplaySettings(); saveDisplayPreferences();
  viewerCommand('background', { value: state.background });
}; });
$('#clayToggle').onchange = event => {
  state.toggles.clay = event.target.checked;
  saveDisplayPreferences(); viewerCommand('clay', { value: state.toggles.clay });
};
$('#explodeToggle').onchange = event => {
  state.toggles.explode = event.target.checked;
  viewerCommand('explode', { value: state.toggles.explode });
};
document.addEventListener('pointerdown', event => {
  if (!$('#displaySettingsPanel').hidden && !$('#displaySettingsPanel').contains(event.target) && !$('#displaySettingsButton').contains(event.target)) setDisplaySettingsOpen(false);
});
window.addEventListener('blur', () => { if (document.activeElement === state.iframe) setDisplaySettingsOpen(false); });
renderDisplaySettings();
[['wireButton', 'wireframe'], ['gridButton', 'grid'], ['animateButton', 'animate']].forEach(([id, type]) => {
  $(`#${id}`).onclick = () => {
    state.toggles[type] = !state.toggles[type];
    $(`#${id}`).setAttribute('aria-pressed', String(state.toggles[type]));
    if (type === 'animate') renderAnimationControl(true);
    viewerCommand(type, { value: state.toggles[type] });
  };
});
$('#exportButton').onclick = async () => {
  const button = $('#exportButton');
  button.disabled = true;
  $('#exportButtonLabel').textContent = '正在导出…';
  const name = safeFilename(`${state.project?.name || 'model'}${state.previewRevision ? `-V${revisionNumber(state.previewRevision.id)}` : ''}`);
  const exportingProjectId = state.project.id;
  try {
    const result = await viewerRpc('export', {}, 60000);
    const response = await fetch(`/api/projects/${encodeURIComponent(exportingProjectId)}/exports`, {method:'POST', headers:{'x-studio-token':token,'Content-Type':'model/gltf-binary'}, body:result.buffer});
    const saved = await response.json();
    if(!response.ok)throw new Error(saved.error||'保存导出文件失败');
    const link=document.createElement('a');link.href=saved.url;link.download=`${name}.glb`;link.hidden=true;document.body.append(link);link.click();link.remove();
    toast('GLB 已保存到项目 exports 文件夹，并已发起下载');
  }
  catch (error) { toast(error.message, true); }
  finally { button.disabled = !state.ready; renderPreviewBanner(); }
};
$('#screenshotButton').onclick = async () => {
  try {
    const result = await viewerRpc('screenshot');
    const bytes = Uint8Array.from(atob(result.dataUrl.split(',')[1]), character => character.charCodeAt(0));
    download(new Blob([bytes], { type: 'image/png' }), `${safeFilename(state.project?.name)}${state.previewRevision ? `-V${revisionNumber(state.previewRevision.id)}` : ''}.png`);
  }
  catch (error) { toast(error.message, true); }
};
$('#partSearch').oninput = renderParts;
$('#collapseParts').onclick = () => {
  const categories = [...new Set(state.parts.map(part => part.category || 'details'))];
  const anyOpen = categories.some(category => state.openCategories.has(category));
  state.openCategories = anyOpen ? new Set() : new Set(categories);
  renderParts();
};
$$('[data-tab]').forEach(button => { button.onclick = () => setTab(button.dataset.tab); });
for (const side of ['left', 'right']) {
  $(side === 'left' ? '#toggleLeft' : '#toggleRight').onclick = () => setPanelOpen(side, getComputedStyle($(`#${side}Panel`)).display === 'none');
}
$('#resetViewButton').onclick = () => { if (state.ready) viewerCommand('view', { view: 'perspective' }); };
$$('[data-close-panel]').forEach(button => { button.onclick = () => setPanelOpen(button.dataset.closePanel, false); });
window.addEventListener('resize', syncPanelControls);
syncPanelControls();
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('#displaySettingsPanel').hidden) { event.preventDefault(); setDisplaySettingsOpen(false, true); return; }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    setPanelOpen('right', true);
    setTab('parts'); $('#partSearch').focus();
  }
  if (event.key === 'Escape' && !$$('dialog[open]').length) { $('#app').classList.remove('left-open', 'right-open'); syncPanelControls(); }
});

function processEvent(data) {
  if (!data || typeof data !== 'object') return;
  if (data.type === 'bridge' || data.type === 'hello') {
    if (typeof data.taskCreating === 'boolean') state.serverCreating = data.taskCreating;
    if (Array.isArray(data.approvals)) { state.approvalSnapshot = data.approvals; syncApprovals(); }
    if (data.bridge) { state.bridge = data.bridge; renderBridge(); }
    return;
  }
  if (data.type === 'taskCreating') { state.serverCreating = data.taskCreating; renderTask(); return; }
  if (data.type === 'approvals') {
    state.approvalSnapshot = [...state.approvalSnapshot.filter(item => item.projectId !== data.projectId), ...(data.approvals || [])];
    syncApprovals(); renderTask(); return;
  }
  if (data.type === 'project' || data.type === 'model') {
    if (!data.project) return;
    rememberProject(data.project);
    if (data.project.id === state.project?.id) setProject(data.project);
    else renderProjects();
    return;
  }
  if (data.projectId !== state.project?.id) return;
  if (data.type === 'task') {
    if (state.project.task?.id !== data.task?.id) { state.liveMessages.clear(); state.activity = ''; state.submissionError = null; }
    state.project.task = data.task;
    if (!isBusy(data.task)) state.stoppingTaskId = null;
    renderTask(); renderMessages();
    if (!isBusy(data.task)) {
      state.approvals.clear(); renderApprovals();
      if (data.task?.status === 'completed') toast('Codex 已完成本轮任务');
    }
  } else if (data.type === 'agent') {
    const event = data.event;
    if (!event) return;
    if (event.type === 'text') {
      const key = event.itemId || 'current-agent-message';
      state.liveMessages.set(key, event.delta ? `${state.liveMessages.get(key) || ''}${event.text || ''}` : event.text || '');
      state.lastActivityAt = Date.now(); state.activity = '正在更新创作进展';
      renderMessages(); renderTask();
    } else if (event.type === 'approval') {
      state.approvals.set(event.requestId, event); renderApprovals(); renderTask();
      if (window.innerWidth <= 690) setPanelOpen('left', true);
    } else if (event.type === 'tool') {
      state.lastActivityAt = Date.now();
      state.activity = event.status === 'inProgress' ? '正在构建与检查模型' : '已完成一个处理步骤，继续创作中';
      renderTask();
    } else if (event.type === 'error') {
      toast(event.message, true);
    } else if (event.type === 'complete') {
      state.approvals.clear(); renderApprovals(); state.activity = ''; renderTask();
      const id = state.project.id;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(async () => {
        try { const project = await api(`/api/projects/${encodeURIComponent(id)}`); if (state.project?.id === id) setProject(project); }
        catch (error) { toast(error.message, true); }
      }, 450);
    }
  }
}

let stopped = false;
const eventController = new AbortController();
let hasSubscribed = false;
async function subscribe() {
  while (!stopped) {
    try {
      const response = await fetch('/api/events', { headers: { 'x-studio-token': token }, signal: eventController.signal });
      if (response.status === 401) { toast('本地连接已更新，请刷新页面后继续。', true); state.streamConnected = false; renderTask(); return; }
      if (!response.ok || !response.body) throw new Error('事件连接不可用');
      state.streamConnected = true; renderTask();
      if (hasSubscribed && state.project?.id) {
        const id = state.project.id;
        const project = await api(`/api/projects/${encodeURIComponent(id)}`);
        if (state.project?.id === id) setProject(project);
      }
      hasSubscribed = true;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const name = block.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim();
          const raw = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (raw && (!name || name === 'studio')) {
            try { processEvent(JSON.parse(raw)); } catch { /* Ignore incomplete or unknown event frames. */ }
          }
        }
        if (buffer.length > 4 * 1024 * 1024) throw new Error('事件数据过大');
      }
    } catch (error) { if (stopped || error.name === 'AbortError') return; }
    state.streamConnected = false; renderTask();
    if (!stopped) await new Promise(resolve => setTimeout(resolve, 2000));
  }
}
const elapsedTimer = setInterval(updateElapsed, 1000);
window.addEventListener('pagehide', () => { stopped = true; eventController.abort(); clearTimeout(refreshTimer); clearInterval(elapsedTimer); creationParticles.destroy(); for (const menu of selectMenus.values()) menu.destroy(); }, { once: true });

async function start() {
  try {
    const bootstrap = await api('/api/bootstrap');
    state.projects = bootstrap.projects || [];
    state.bridge = bootstrap.bridge || state.bridge;
    state.serverCreating = Boolean(bootstrap.taskCreating);
    state.approvalSnapshot = bootstrap.approvals || [];
    state.revisionPreviewApi = Boolean(bootstrap.capabilities?.revisionPreview);
    state.imageGroupsEnabled = Boolean(bootstrap.capabilities?.imageGroups);
    state.imageLimits = { ...state.imageLimits, ...(bootstrap.capabilities?.imageLimits || {}) };
    state.skillUrl = bootstrap.skill?.url || state.skillUrl;
    $('#downloadSkill').href = state.skillUrl;
    renderProjects(); renderBridge();
    const previous = sessionStorage.getItem('studio-active-project');
    const id = state.projects.some(project => project.id === previous) ? previous : bootstrap.activeProjectId || state.projects[0]?.id;
    if (id) await selectProject(id);
    else { showDialog('#newProjectDialog'); }
    void subscribe();
  } catch (error) {
    $('#viewportMount').innerHTML = `<div class="stage-placeholder"><span class="large-cube">◇</span><p>暂时无法打开工作空间</p><p>${escapeHtml(error.message)}</p><button class="subtle-button" id="retryBootstrap">重试连接</button></div>`;
    $('#retryBootstrap').onclick = start;
    toast(error.message, true);
  }
}

void start();
