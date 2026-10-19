export const PROVIDERS = Object.freeze({ codex: 'Codex CLI', openai: 'OpenAI', deepseek: 'DeepSeek', gemini: 'Gemini', grok: 'Grok (xAI)' });
const apiProviderIds = Object.keys(PROVIDERS).filter(id => id !== 'codex');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

/** Only retain public configuration fields, even if a server accidentally sends extras. */
export function publicSettings(value = {}) {
  return {
    workspaceRoot: String(value.workspaceRoot || ''),
    workspaceHistory: (Array.isArray(value.workspaceHistory) ? value.workspaceHistory : []).filter(item => typeof item === 'string'),
    codexConcurrency: value.codexConcurrency ?? 1,
    apiConcurrency: value.apiConcurrency ?? 1,
    defaultProvider: Object.hasOwn(PROVIDERS, value.defaultProvider) ? value.defaultProvider : 'codex',
    providers: Object.fromEntries(apiProviderIds.map(id => {
      const provider = value.providers?.[id] || {};
      return [id, { baseUrl: String(provider.baseUrl || ''), model: String(provider.model || ''), supportsImages: provider.supportsImages === true, hasApiKey: provider.hasApiKey === true }];
    })),
  };
}

/** API keys live only in password inputs until submitted; closing clears those inputs. */
export function createSettingsPanel({ dialog, api, onSettings, onModels = () => {}, onSelectProject = () => {} }) {
  const $ = selector => dialog.querySelector(selector);
  const form = $('#settingsForm');
  let current = publicSettings(), session = 0, busy = false;
  const requests = new Map();
  $('#settingsDefaultProvider').innerHTML = Object.entries(PROVIDERS).map(([id, name]) => `<option value="${id}">${name}</option>`).join('');
  $('#providerSettings').innerHTML = apiProviderIds.map(id => `<details class="provider-settings" data-provider="${id}">
    <summary><strong>${PROVIDERS[id]}</strong><span id="${id}KeyState" class="settings-key-state"></span></summary>
    <div class="provider-settings-body">
      <label class="field-label" for="${id}BaseUrl">接口地址（Base URL）</label>
      <input id="${id}BaseUrl" class="text-input" type="url" placeholder="服务的 API 基础地址" autocomplete="off" spellcheck="false">
      <label class="field-label" for="${id}ApiKey">API Key</label>
      <input id="${id}ApiKey" class="text-input" type="password" autocomplete="new-password" spellcheck="false" placeholder="留空保持已保存的密钥" aria-describedby="${id}KeyHint">
      <p id="${id}KeyHint" class="settings-hint">密钥保存后不会回显；关闭窗口会清空本次输入。</p>
      <label class="settings-checkbox"><input id="${id}ClearKey" type="checkbox">清除已保存的密钥</label>
      <label class="field-label" for="${id}Model">默认模型</label>
      <div class="settings-model-row"><input id="${id}Model" class="text-input" type="text" list="${id}Models" placeholder="获取列表后选择，也可以手动填写模型 ID" autocomplete="off" spellcheck="false"><button type="button" class="subtle-button" data-provider-action="models" data-provider-id="${id}">获取模型</button></div>
      <datalist id="${id}Models"></datalist>
      <label class="settings-checkbox"><input id="${id}SupportsImages" type="checkbox">使用支持图片输入的模型</label>
      <p class="settings-hint">按所选模型的能力设置；关闭后只能发送文字要求。</p>
      <button type="button" class="subtle-button" data-provider-action="test" data-provider-id="${id}">测试连接</button>
      <p id="${id}Status" class="settings-status" role="status" aria-live="polite"></p>
    </div>
  </details>`).join('');

  function status(node, message, error = false) {
    // Provider failures should not reflect a freshly entered key back into the page.
    let text = String(message || '');
    for (const id of apiProviderIds) {
      const key = $(`#${id}ApiKey`).value.trim();
      if (key) text = text.replaceAll(key, '[密钥已隐藏]');
    }
    node.textContent = text;
    node.dataset.error = String(error);
  }

  function setBusy(value) {
    busy = value;
    for (const fieldset of form.querySelectorAll('fieldset')) fieldset.disabled = value;
    $('#saveSettings').disabled = value;
    form.setAttribute('aria-busy', String(value));
  }

  function clearKeys() {
    for (const id of apiProviderIds) { $(`#${id}ApiKey`).value = ''; $(`#${id}ClearKey`).checked = false; }
  }

  function fill(settings) {
    for (const control of dialog.querySelectorAll('[data-provider-action]')) control.disabled = false;
    $('#settingsWorkspace').value = settings.workspaceRoot;
    $('#workspaceHistory').innerHTML = settings.workspaceHistory.map(value => `<option value="${escapeHtml(value)}"></option>`).join('');
    $('#settingsCodexConcurrency').value = settings.codexConcurrency;
    $('#settingsApiConcurrency').value = settings.apiConcurrency;
    $('#settingsDefaultProvider').value = settings.defaultProvider;
    for (const id of apiProviderIds) {
      const provider = settings.providers[id];
      $(`#${id}BaseUrl`).value = provider.baseUrl;
      $(`#${id}Model`).value = provider.model;
      $(`#${id}SupportsImages`).checked = provider.supportsImages;
      $(`#${id}KeyState`).textContent = provider.hasApiKey ? '密钥已配置' : '未配置密钥';
      $(`#${id}ApiKey`).disabled = false;
      status($(`#${id}Status`), '');
    }
    clearKeys();
  }

  function providerDraft(id) {
    const apiKey = $(`#${id}ApiKey`).value.trim();
    const clearApiKey = $(`#${id}ClearKey`).checked;
    return {
      baseUrl: $(`#${id}BaseUrl`).value.trim(),
      model: $(`#${id}Model`).value.trim(),
      supportsImages: $(`#${id}SupportsImages`).checked,
      ...(clearApiKey ? { clearApiKey: true } : apiKey ? { apiKey } : {}),
    };
  }

  for (const id of apiProviderIds) $(`#${id}ClearKey`).onchange = event => {
    $(`#${id}ApiKey`).disabled = event.target.checked;
    if (event.target.checked) $(`#${id}ApiKey`).value = '';
  };

  for (const button of dialog.querySelectorAll('[data-provider-action]')) button.onclick = async () => {
    const id = button.dataset.providerId, action = button.dataset.providerAction;
    const draft = providerDraft(id), node = $(`#${id}Status`), activeSession = session;
    if (draft.clearApiKey) return status(node, '请先保存清除密钥的设置，或取消清除后再测试。', true);
    if (!$(`#${id}BaseUrl`).reportValidity()) return;
    const request = (requests.get(id) || 0) + 1;
    requests.set(id, request);
    for (const control of dialog.querySelectorAll(`[data-provider-id="${id}"]`)) control.disabled = true;
    status(node, action === 'models' ? '正在获取模型列表…' : '正在测试连接…');
    try {
      const result = await api(`/api/providers/${id}/${action}`, { method: 'POST', body: draft });
      if (activeSession !== session || requests.get(id) !== request) return;
      if (JSON.stringify(providerDraft(id)) !== JSON.stringify(draft)) return status(node, '配置已修改，请重新获取或测试。');
      if (action === 'models') {
        const models = (Array.isArray(result.models) ? result.models : []).filter(model => typeof model?.id === 'string');
        $(`#${id}Models`).innerHTML = models.map(model => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.name || model.id)}</option>`).join('');
        onModels(id, models, draft);
        status(node, models.length ? `已获取 ${models.length} 个模型，可在默认模型中选择或手动输入。` : '服务没有返回模型列表，可手动填写模型 ID。');
      } else status(node, '连接成功；生成权限和额度以实际任务为准。保存设置后生效。');
    } catch (error) { if (activeSession === session) status(node, error.message, true); }
    finally { if (activeSession === session && requests.get(id) === request) for (const control of dialog.querySelectorAll(`[data-provider-id="${id}"]`)) control.disabled = false; }
  };

  form.onsubmit = async event => {
    event.preventDefault();
    if (busy || !form.reportValidity()) return;
    const patch = {
      workspaceRoot: $('#settingsWorkspace').value.trim(),
      codexConcurrency: $('#settingsCodexConcurrency').valueAsNumber,
      apiConcurrency: $('#settingsApiConcurrency').valueAsNumber,
      defaultProvider: $('#settingsDefaultProvider').value,
      providers: Object.fromEntries(apiProviderIds.map(id => [id, providerDraft(id)])),
    };
    const activeSession = session;
    setBusy(true); status($('#settingsStatus'), '正在保存设置…');
    try {
      const result = publicSettings(await api('/api/settings', { method: 'PUT', body: patch }));
      current = result;
      await onSettings(result);
      if (activeSession === session) { fill(result); status($('#settingsStatus'), '设置已保存。'); }
    } catch (error) { if (activeSession === session) status($('#settingsStatus'), error.message, true); }
    finally { if (activeSession === session) setBusy(false); }
  };

  dialog.addEventListener('close', () => { session++; clearKeys(); setBusy(false); });
  return {
    update(settings) { current = publicSettings(settings); },
    async open({ queue = false } = {}) {
      if (dialog.open) return;
      const activeSession = ++session;
      fill(current); status($('#settingsStatus'), '正在读取设置…'); setBusy(true);
      dialog.showModal();
      if (queue) $('#settingsQueue').scrollIntoView({ block: 'nearest' });
      try {
        const result = publicSettings(await api('/api/settings'));
        if (activeSession !== session) return;
        current = result;
        await onSettings(result);
        if (activeSession === session) { fill(result); status($('#settingsStatus'), ''); }
      } catch (error) { if (activeSession === session) status($('#settingsStatus'), error.message, true); }
      finally { if (activeSession === session) setBusy(false); }
    },
    updateScheduler(scheduler, projects) {
      const names = new Map(projects.map(project => [project.id, project.name]));
      const rows = [...(scheduler.active || []).map(entry => ({ ...entry, label: '运行中' })), ...(scheduler.queued || []).map(entry => ({ ...entry, label: `排队 ${entry.position || entry.task?.queuePosition || '中'}` }))];
      $('#settingsTaskList').replaceChildren();
      if (!rows.length) { $('#settingsTaskList').textContent = '当前没有运行或排队的任务。'; return; }
      for (const entry of rows) {
        const row = document.createElement('div'); row.className = 'settings-task-row';
        const button = document.createElement('button'); button.type = 'button'; button.textContent = names.get(entry.projectId) || entry.projectId;
        button.onclick = () => { dialog.close(); onSelectProject(entry.projectId); };
        const label = document.createElement('span'); label.textContent = `${PROVIDERS[entry.task?.provider] || PROVIDERS.codex} · ${entry.label}`;
        row.append(button, label); $('#settingsTaskList').append(row);
      }
    },
  };
}
