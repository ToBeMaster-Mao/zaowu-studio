import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeConversationImages, normalizeConversationGroups } from './conversation-images.js';

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

test('empty drafts are omitted, group IDs stay unique, labels and group count are bounded', () => {
  const groups = normalizeConversationGroups([
    { id: 'empty', images: [] },
    ...Array.from({ length: 10 }, (_, i) => ({ id: 'reused', label: i ? '长'.repeat(90) : ' ', images: [image(String(i))] })),
  ]);
  assert.equal(groups.length, 8);
  assert.equal(new Set(groups.map(group => group.id)).size, 8);
  assert.equal(groups[0].label, '图片组 1');
  assert.equal(groups[1].label.length, 60);
});
