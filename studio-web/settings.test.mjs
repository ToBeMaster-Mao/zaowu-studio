import test from 'node:test';
import assert from 'node:assert/strict';
import { publicSettings } from './settings.js';

test('public settings retain configuration and key presence without retaining returned credentials', () => {
  const settings = publicSettings({
    workspaceRoot: 'D:/模型工程', workspaceHistory: ['D:/旧项目'],
    codexConcurrency: 3, apiConcurrency: 2, defaultProvider: 'openai',
    apiKey: 'unexpected-top-level-secret',
    providers: {
      openai: { baseUrl: 'https://example.test/v1', model: 'image-model', supportsImages: true, hasApiKey: true, apiKey: 'unexpected-provider-secret' },
      unexpected: { apiKey: 'unexpected-service-secret' },
    },
  });
  assert.equal(settings.workspaceRoot, 'D:/模型工程');
  assert.deepEqual(settings.workspaceHistory, ['D:/旧项目']);
  assert.equal(settings.defaultProvider, 'openai');
  assert.equal(settings.providers.openai.hasApiKey, true);
  assert.equal(settings.providers.openai.model, 'image-model');
  assert.equal(settings.providers.openai.supportsImages, true);
  assert.equal(Object.hasOwn(settings, 'apiKey'), false);
  assert.equal(Object.hasOwn(settings.providers.openai, 'apiKey'), false);
  assert.equal(Object.hasOwn(settings.providers, 'unexpected'), false);
  assert.doesNotMatch(JSON.stringify(settings), /secret/);
});
