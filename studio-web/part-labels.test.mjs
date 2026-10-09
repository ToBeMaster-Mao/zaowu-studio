import test from 'node:test';
import assert from 'node:assert/strict';
import { partLabel, partDetail } from './part-labels.js';

test('cockpit display labels retain the six distinct pane positions and source IDs', () => {
  const labels = new Set();
  for (const side of [-1, 1]) for (const index of [0, 1, 2]) {
    const part = Object.freeze({ name: `Cockpit_glass_${side}_${index}`, id: `/Cockpit_glass_${side}_${index}` });
    labels.add(partLabel(part));
    assert.equal(partDetail(part), '驾驶舱玻璃');
    assert.equal(part.id, `/${part.name}`);
  }
  assert.equal(labels.size, 6);
  assert.equal(partLabel({ name: 'Cockpit_glass_-1_0' }), '前风挡 · A侧');
  assert.equal(partLabel({ name: 'Cockpit_frame_1_2' }), '后侧窗框 · B侧');
});

test('numbered parts and identical fan names remain recognizable across sides', () => {
  assert.equal(partLabel({ name: 'Window_1_0' }), '舷窗 01 · B侧');
  assert.equal(partLabel({ name: 'WindowFrame_-1_19' }), '舷窗框 20 · A侧');
  assert.equal(partLabel({ name: 'Fan_blade_0', parentId: '/Engine_-1/Fan_L' }), '扇叶 01 · A侧');
  assert.equal(partLabel({ name: 'Fan_blade_0', parentId: '/Engine_1/Fan_R' }), '扇叶 01 · B侧');
  assert.equal(partLabel({ name: 'Main_tyre_-1_-0.42_hub' }), '主轮轮毂 01 · A侧');
});

test('lamp names translate while custom names and unsupported indices keep their wording', () => {
  assert.equal(partLabel({ name: 'Curved_Arm' }), '弧形支臂');
  assert.equal(partLabel({ name: 'Cup_Handle' }), '杯把');
  assert.equal(partDetail({ name: 'Base' }), '底部支撑');
  assert.equal(partLabel({ name: '我的_自定义灯罩' }), '我的 自定义灯罩');
  assert.equal(partLabel({ name: 'Cockpit_glass_-1_7' }), 'Cockpit glass -1 7');
  assert.equal(partDetail({ name: 'Custom_assembly', kind: 'group' }), '部件分组');
  assert.equal(partLabel(null), '未命名部件');
});

test('generic stems and fans do not acquire lamp or aircraft meaning', () => {
  assert.equal(partLabel({ name: 'Stem' }), '支杆');
  assert.equal(partDetail({ name: 'Stem' }), '支撑结构');
  assert.equal(partDetail({ name: 'Fan_blade_0' }), '风扇结构');
  assert.equal(partDetail({ name: 'Fan_blade_0', parentId: '/Engine_1/Fan_R' }), '发动机风扇');
  assert.equal(partDetail({ name: 'Fan_R' }), '风扇结构');
  assert.equal(partLabel({ name: 'Spinner' }), 'Spinner');
});

test('custom names that resemble JavaScript prototype properties stay safe', () => {
  assert.equal(partLabel({ name: 'constructor_1' }), 'constructor 1');
  assert.equal(partLabel({ name: '__proto___1' }), '  proto   1');
  assert.equal(partDetail({ name: 'Custom', category: 'constructor' }), '模型部件');
});
