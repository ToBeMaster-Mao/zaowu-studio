import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rmdir, stat, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SettingsStore, API_PROVIDER_IDS } from './settings-store.mjs';

const output = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-output', 'settings');
async function fixture() {
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(path.join(output, 'case-'));
  const file = path.join(directory, 'private', 'settings.json');
  const workspaceRoot = path.join(directory, 'projects');
  const store = new SettingsStore({ file, defaultWorkspaceRoot: workspaceRoot });
  return { directory, file, workspaceRoot, store };
}

test('defaults create an independent workspace and restrict settings file permissions', async () => {
  const { store, file, workspaceRoot } = await fixture();
  assert.equal(await store.init(), store);
  const saved = store.publicSettings();
  assert.equal(saved.workspaceRoot, workspaceRoot);
  assert.deepEqual(saved.workspaceHistory, [workspaceRoot]);
  assert.equal(saved.defaultProvider, 'codex');
  assert.equal(saved.codexConcurrency, 1);
  assert.equal(saved.apiConcurrency, 1);
  assert.deepEqual(Object.keys(saved.providers), API_PROVIDER_IDS);
  assert.equal(saved.providers.openai.baseUrl, 'https://api.openai.com/v1');
  assert.equal(saved.providers.deepseek.baseUrl, 'https://api.deepseek.com');
  assert.equal(saved.providers.gemini.baseUrl, 'https://generativelanguage.googleapis.com/v1beta');
  assert.equal(saved.providers.grok.baseUrl, 'https://api.x.ai/v1');
  assert.ok(API_PROVIDER_IDS.every(id => saved.providers[id].model === '' && saved.providers[id].supportsImages && !saved.providers[id].hasApiKey));
  assert.ok((await stat(workspaceRoot)).isDirectory());
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  else {
    const script = `$acl = [System.IO.File]::GetAccessControl($env:ZAOWU_SETTINGS_FILE); [System.Console]::WriteLine($acl.AreAccessRulesProtected); [System.Console]::WriteLine([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value); foreach($rule in $acl.Access) {[System.Console]::WriteLine($rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value)}`;
    const [protectedAcl, current, ...rules] = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, env: { ...process.env, ZAOWU_SETTINGS_FILE: file } }).trim().split(/\r?\n/);
    assert.equal(protectedAcl, 'True');
    assert.deepEqual(rules, [current]);
  }
});

test('public snapshots mask keys, remain independent and persist provider settings across restart', async () => {
  const { store, file, directory, workspaceRoot } = await fixture();
  const updated = await store.update({ defaultProvider: 'openai', providers: { openai: { apiKey: ' test-only-secret ', model: 'sample-model', supportsImages: false } } });
  assert.equal(updated.providers.openai.hasApiKey, true);
  assert.equal(Object.hasOwn(updated.providers.openai, 'apiKey'), false);
  assert.ok(!JSON.stringify(updated).includes('test-only-secret'));
  updated.providers.openai.model = 'mutated';
  updated.workspaceHistory.push('mutated');
  assert.equal(store.publicSettings().providers.openai.model, 'sample-model');
  assert.deepEqual(store.publicSettings().workspaceHistory, [workspaceRoot]);
  const reopened = new SettingsStore({ file, defaultWorkspaceRoot: path.join(directory, 'unused-default') });
  await reopened.init();
  assert.equal(reopened.getProvider('openai').apiKey, 'test-only-secret');
  assert.equal(reopened.publicSettings().providers.openai.supportsImages, false);
  assert.equal(reopened.publicSettings().defaultProvider, 'openai');
  assert.deepEqual(await readdir(path.dirname(file)), ['settings.json'], 'Atomic writes should leave no temporary credential files');
});

test('blank secrets preserve the existing key, explicit clearing removes it, temporary overrides do not save', async () => {
  const { store, file } = await fixture();
  await store.update({ providers: { grok: { apiKey: 'test-only-secret' } } });
  await store.update({ providers: { grok: { apiKey: ' \n\t ', model: 'stored-model' } } });
  assert.equal(store.getProvider('grok').apiKey, 'test-only-secret');
  const before = await readFile(file, 'utf8');
  const provider = store.getProvider('grok', { apiKey: 'temporary-secret', model: 'temporary-model', baseUrl: 'http://localhost:9090/v1/' });
  assert.equal(provider.apiKey, 'temporary-secret');
  assert.equal(provider.baseUrl, 'http://localhost:9090/v1');
  assert.equal(store.getProvider('grok').model, 'stored-model');
  assert.equal(await readFile(file, 'utf8'), before);
  assert.deepEqual(store.getProvider('codex'), { id: 'codex', baseUrl: '', apiKey: '', model: '', supportsImages: true });
  const cleared = await store.update({ providers: { grok: { apiKey: '', clearApiKey: true } } });
  assert.equal(cleared.providers.grok.hasApiKey, false);
  assert.equal(store.getProvider('grok').apiKey, '');
  assert.ok(!(await readFile(file, 'utf8')).includes('test-only-secret'));
});

test('concurrent updates merge without losing provider secrets and recover after a rejected request', async () => {
  const { store } = await fixture();
  const results = await Promise.allSettled([
    store.update({ providers: { openai: { apiKey: 'first-secret' } } }),
    store.update({ codexConcurrency: 4 }),
    store.update({ apiConcurrency: 9 }),
    store.update({ apiConcurrency: 3, providers: { deepseek: { apiKey: 'second-secret' } } }),
  ]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled', 'rejected', 'fulfilled']);
  assert.equal(store.getProvider('openai').apiKey, 'first-secret');
  assert.equal(store.getProvider('deepseek').apiKey, 'second-secret');
  assert.equal(store.publicSettings().codexConcurrency, 4);
  assert.equal(store.publicSettings().apiConcurrency, 3);
});

test('workspace changes retain history and previous projects without moving or deleting files', async () => {
  const { store, directory, workspaceRoot } = await fixture();
  await store.init();
  const marker = path.join(workspaceRoot, 'existing-project.txt');
  await writeFile(marker, 'existing project');
  const second = path.join(directory, 'another-workspace');
  let settings = await store.update({ workspaceRoot: second });
  assert.equal(settings.workspaceRoot, second);
  assert.deepEqual(settings.workspaceHistory, [second, workspaceRoot]);
  assert.equal(await readFile(marker, 'utf8'), 'existing project');
  assert.deepEqual(await readdir(second), []);
  settings = await store.update({ workspaceRoot });
  assert.deepEqual(settings.workspaceHistory, [workspaceRoot, second]);
  assert.equal(await readFile(marker, 'utf8'), 'existing project');
});

test('invalid patches reject without changing persisted settings or leaking supplied secrets', async () => {
  const { store, file } = await fixture();
  await store.update({ providers: { openai: { apiKey: 'keep-this-secret' } } });
  const before = await readFile(file, 'utf8');
  const patches = [
    null, [], { unknown: true }, { workspaceRoot: 'relative/path' }, { workspaceRoot: '//server/share' },
    { workspaceHistory: [] }, { codexConcurrency: 0 }, { apiConcurrency: 9 }, { apiConcurrency: 1.5 },
    { codexConcurrency: '2' }, { defaultProvider: 'unknown' }, { providers: { unknown: {} } },
    { providers: { openai: [] } }, { providers: { openai: { hasApiKey: true } } },
    { providers: { openai: { supportsImages: 'true' } } }, { providers: { openai: { model: 1 } } },
    { providers: { openai: { apiKey: null } } }, { providers: { openai: { clearApiKey: 'true' } } },
    { providers: { openai: { clearApiKey: true, apiKey: 'never-echo-this-key' } } },
    ...['http://example.com/v1', 'ftp://example.com', 'https://user:never-echo-this-key@example.com',
      'https://example.com?api_key=never-echo-this-key', 'https://example.com#fragment', 'https://example.com?',
      'https://example.com#', 'https:\\example.com'].map(baseUrl => ({ providers: { openai: { baseUrl } } })),
  ];
  for (const patch of patches) {
    await assert.rejects(store.update(patch), error => {
      assert.ok(!error.message.includes('never-echo-this-key'));
      return error.status === 400;
    });
    assert.equal(await readFile(file, 'utf8'), before);
  }
  assert.equal(store.getProvider('openai').apiKey, 'keep-this-secret');
  assert.throws(() => store.getProvider('unknown'), error => error.status === 400);
});

test('malformed or invalid saved settings are never replaced with defaults and errors omit secrets', async () => {
  for (const content of [
    '{"providers":{"openai":{"apiKey":"private-test-value"}}',
    JSON.stringify({ providers: { unknown: { apiKey: 'private-test-value' } } }),
    JSON.stringify({ apiConcurrency: 99, providers: { openai: { apiKey: 'private-test-value' } } }),
    'null',
  ]) {
    const { store, file } = await fixture();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
    await assert.rejects(store.init(), error => error.status === 500 && !error.message.includes('private-test-value'));
    await assert.rejects(store.update({ defaultProvider: 'codex' }));
    assert.equal(await readFile(file, 'utf8'), content);
  }
});

test('settings cannot be placed inside the active workspace, including directory aliases', async t => {
  const { store, directory, file } = await fixture();
  await store.init();
  const before = await readFile(file, 'utf8');
  await assert.rejects(store.update({ workspaceRoot: directory }), /设置文件不能位于工作空间内/);
  const unsafe = new SettingsStore({ file: path.join(directory, 'unsafe', 'settings.json'), defaultWorkspaceRoot: path.join(directory, 'unsafe') });
  await assert.rejects(unsafe.init(), /设置文件不能位于工作空间内/);
  const alias = path.join(directory, 'alias');
  try { await symlink(path.dirname(file), alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.diagnostic('Directory alias check unavailable on this host'); return; } throw error; }
  await assert.rejects(store.update({ workspaceRoot: alias }), /设置文件不能位于工作空间内/);
  assert.equal(await readFile(file, 'utf8'), before);
});

test('a path to a regular file is not accepted as a workspace', async () => {
  const { store, directory } = await fixture();
  await store.init();
  const existingFile = path.join(directory, 'not-a-directory');
  await writeFile(existingFile, 'leave intact');
  await assert.rejects(store.update({ workspaceRoot: existingFile }));
  assert.equal(await readFile(existingFile, 'utf8'), 'leave intact');
});

test('a persistence failure leaves committed in-memory settings intact and the queue remains usable', async () => {
  const { store, file } = await fixture();
  await store.update({ providers: { openai: { apiKey: 'original-test-secret' } } });
  const backup = `${file}.backup`;
  await rename(file, backup);
  await mkdir(file);
  await assert.rejects(store.update({ apiConcurrency: 7, providers: { openai: { apiKey: 'failed-test-secret' } } }), error => error.status === 403);
  assert.equal(store.publicSettings().apiConcurrency, 1);
  assert.equal(store.getProvider('openai').apiKey, 'original-test-secret');
  await rmdir(file);
  await rename(backup, file);
  await store.update({ apiConcurrency: 2 });
  assert.equal(store.publicSettings().apiConcurrency, 2);
  assert.ok(!(await readFile(file, 'utf8')).includes('failed-test-secret'));
});

test('a symlink cannot be used as the credential settings file', async t => {
  const { file, workspaceRoot, directory } = await fixture();
  await mkdir(path.dirname(file), { recursive: true });
  const target = path.join(directory, 'do-not-read-or-replace.json');
  await writeFile(target, 'target remains unchanged');
  try { await symlink(target, file, 'file'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('File symlinks unavailable on this host'); return; } throw error; }
  const store = new SettingsStore({ file, defaultWorkspaceRoot: workspaceRoot });
  await assert.rejects(store.init(), error => error.status === 403);
  assert.equal(await readFile(target, 'utf8'), 'target remains unchanged');
});

test('preview validates and prepares a workspace without committing settings or revealing keys', async () => {
  const { store, directory, file, workspaceRoot } = await fixture();
  await store.update({ providers: { gemini: { apiKey: 'existing-preview-secret' } } });
  const before = await readFile(file, 'utf8');
  const candidate = path.join(directory, 'candidate-workspace');
  const preview = await store.preview({ workspaceRoot: candidate, apiConcurrency: 6, providers: { openai: { apiKey: 'candidate-preview-secret' } } });
  assert.equal(preview.workspaceRoot, candidate);
  assert.equal(preview.apiConcurrency, 6);
  assert.equal(preview.providers.openai.hasApiKey, true);
  assert.equal(preview.providers.gemini.hasApiKey, true);
  assert.ok(!JSON.stringify(preview).includes('preview-secret'));
  assert.ok((await stat(candidate)).isDirectory());
  assert.equal(store.publicSettings().workspaceRoot, workspaceRoot);
  assert.equal(store.publicSettings().apiConcurrency, 1);
  assert.equal(store.getProvider('openai').apiKey, '');
  await assert.rejects(store.preview({ providers: { gemini: { baseUrl: 'http://remote.example' } } }), error => error.status === 400);
  assert.equal(await readFile(file, 'utf8'), before);
});
