import test from 'node:test';
import assert from 'node:assert/strict';
import { createSkillInstallGuide } from './skill-install.js';

test('installation instructions resolve the running service port and package endpoint', () => {
  const guide = createSkillInstallGuide({ origin: 'http://127.0.0.1:4176' });
  assert.equal(guide.url, 'http://127.0.0.1:4176/downloads/model-studio-skill.zip');
  assert.ok(guide.instructions.includes(guide.url));
  assert.ok(guide.instructions.includes('model-studio/SKILL.md'));
  assert.ok(guide.instructions.includes('$model-studio'));
});

test('installation instructions use the bootstrap package URL on the current origin', () => {
  const guide = createSkillInstallGuide({
    origin: 'http://localhost:5180',
    skillUrl: 'http://localhost:5180/downloads/new-package.zip',
  });
  assert.equal(guide.url, 'http://localhost:5180/downloads/new-package.zip');
});

test('package links cannot direct an Agent to another origin or leak credentials', () => {
  const origin = 'http://127.0.0.1:4174';
  for (const skillUrl of [
    'https://example.com/package.zip',
    '//example.com/package.zip',
    'http://127.0.0.1:4175/package.zip',
    'http://user:password@127.0.0.1:4174/package.zip',
    '/downloads/model-studio-skill.zip?token=secret',
    '/downloads/model-studio-skill.zip#secret',
    'javascript:alert(1)',
  ]) {
    assert.throws(() => createSkillInstallGuide({ origin, skillUrl }), /下载地址无效/);
  }
  assert.throws(() => createSkillInstallGuide({ origin: 'file:///tmp/page.html' }), /下载地址无效/);
});
