import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createExplodedView } from './exploded-view.js';

function mesh(size = 1) {
  return new THREE.Mesh(new THREE.BoxGeometry(size, size, size), new THREE.MeshBasicMaterial());
}

function assembly() {
  const root = new THREE.Group(), wrapper = new THREE.Group();
  const body = new THREE.Group(), attachment = new THREE.Group();
  body.add(mesh(4));
  const detail = mesh(.5);
  detail.position.set(.1, .2, .3);
  attachment.add(mesh(), detail);
  attachment.position.set(0, 3, 0);
  wrapper.add(body, attachment, new THREE.DirectionalLight());
  root.add(wrapper);
  return { root, wrapper, body, attachment, detail };
}

function near(a, b, epsilon = 1e-9) {
  assert.ok(a.distanceTo(b) < epsilon, `${a.toArray()} differs from ${b.toArray()}`);
}

test('unwraps model containers and keeps each nested assembly coherent', () => {
  const { root, wrapper, body, attachment, detail } = assembly();
  const localDetail = detail.position.clone();
  const motion = createExplodedView(root);
  assert.equal(motion.supported, true);
  motion.setExpanded(true);
  motion.update(.35);
  assert.equal(motion.moving, true);
  assert.ok(attachment.position.y > 3);
  assert.ok(attachment.position.y < 5);
  near(wrapper.position, new THREE.Vector3());
  near(body.position, new THREE.Vector3());
  near(detail.position, localDetail);
  motion.update(1);
  assert.equal(motion.moving, false);
  assert.equal(motion.expanded, true);
});

test('world-space separation accounts for rotated nonuniformly scaled parents', () => {
  const { root, wrapper, attachment } = assembly();
  wrapper.scale.set(2, .5, 3);
  wrapper.rotation.set(.3, .8, -.2);
  root.position.set(20, -4, 13);
  root.updateMatrixWorld(true);
  const oldWorld = attachment.getWorldPosition(new THREE.Vector3());
  const expected = new THREE.Vector3(0, 1, 0).applyMatrix3(new THREE.Matrix3().setFromMatrix4(wrapper.matrixWorld)).normalize();
  const motion = createExplodedView(root);
  motion.setExpanded(true);
  motion.update(1);
  const movement = attachment.getWorldPosition(new THREE.Vector3()).sub(oldWorld);
  assert.ok(movement.length() > 0);
  near(movement.normalize(), expected);
  motion.setExpanded(false);
  motion.update(1);
  assert.deepEqual(attachment.position.toArray(), [0, 3, 0]);
});

test('uses baked geometry centers and separates coincident centers without NaN', () => {
  const root = new THREE.Group();
  const body = mesh(4), eccentric = mesh(), coincident = mesh(.5);
  eccentric.geometry.translate(5, 0, 0);
  root.add(body, eccentric, coincident);
  const motion = createExplodedView(root);
  motion.setExpanded(true);
  motion.update(1);
  assert.ok(eccentric.position.x > 0);
  assert.equal(eccentric.position.y, 0);
  assert.equal(eccentric.position.z, 0);
  assert.ok(coincident.position.length() > 0);
  assert.ok([...coincident.position].every(Number.isFinite));
});

test('rapid reversals and repeated toggles restore exact local positions without drift', () => {
  const { root, attachment } = assembly();
  attachment.position.set(.123456789, 3.123456789, -.987654321);
  const original = attachment.position.toArray();
  const motion = createExplodedView(root);
  for (let i = 0; i < 100; i++) {
    motion.setExpanded(true);
    motion.update(.13);
    motion.setExpanded(false);
    motion.update(.04);
    motion.setExpanded(true);
    motion.update(1);
    motion.setExpanded(false);
    motion.update(1);
    assert.deepEqual(attachment.position.toArray(), original);
  }
});

test('editing an expanded part changes its rest position and preserves nested edit semantics', () => {
  const { root, attachment, detail } = assembly();
  const motion = createExplodedView(root);
  motion.setExpanded(true);
  motion.update(1);
  assert.deepEqual(motion.getRestPosition(attachment).toArray(), [0, 3, 0]);
  motion.updateRestPosition(attachment, [2, 5, -1]);
  motion.setRestPosition(detail, new THREE.Vector3(.4, .5, .6));
  assert.deepEqual(motion.getRestPosition(attachment).toArray(), [2, 5, -1]);
  assert.notDeepEqual(attachment.position.toArray(), [2, 5, -1]);
  assert.deepEqual(motion.getRestPosition(detail).toArray(), [.4, .5, .6]);
  motion.setExpanded(false);
  motion.update(1);
  assert.deepEqual(attachment.position.toArray(), [2, 5, -1]);
  assert.deepEqual(detail.position.toArray(), [.4, .5, .6]);
});

test('async export sees assembled geometry and restores exact display even on failure', async () => {
  const { root, attachment } = assembly();
  const motion = createExplodedView(root);
  motion.setExpanded(true);
  motion.update(.3);
  const display = attachment.position.toArray();
  await assert.rejects(motion.withRestPose(async () => {
    assert.deepEqual(attachment.position.toArray(), [0, 3, 0]);
    await Promise.resolve();
    assert.equal(motion.update(.5), false);
    assert.deepEqual(attachment.position.toArray(), [0, 3, 0]);
    await motion.withRestPose(() => assert.deepEqual(attachment.position.toArray(), [0, 3, 0]));
    throw new Error('export failed');
  }), /export failed/);
  assert.deepEqual(attachment.position.toArray(), display);
  assert.equal(motion.update(.1), true);
});

test('manual matrices preserve their original basis and assembled position', async () => {
  const { root, attachment } = assembly();
  attachment.rotation.set(.3, .2, .1);
  attachment.scale.set(.6, .8, 1.2);
  attachment.updateMatrix();
  attachment.matrixAutoUpdate = false;
  const original = attachment.matrix.toArray();
  const motion = createExplodedView(root);
  motion.setExpanded(true);
  motion.update(1);
  assert.notDeepEqual(attachment.matrix.toArray(), original);
  await motion.withRestPose(() => assert.deepEqual(attachment.matrix.toArray(), original));
  motion.setExpanded(false);
  motion.update(1);
  assert.deepEqual(attachment.matrix.toArray(), original);
});

test('single meshes, empty roots and rigged meshes do not offer misleading disassembly', () => {
  for (const root of [mesh(), new THREE.Group()]) {
    const motion = createExplodedView(root);
    assert.equal(motion.canExplode, false);
    assert.equal(motion.setExpanded(true), false);
    assert.equal(motion.update(1), false);
  }
  const root = new THREE.Group();
  root.add(new THREE.SkinnedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()), mesh());
  assert.equal(createExplodedView(root).supported, false);
});

test('dispose restores the assembled pose and prevents future motion', () => {
  const { root, attachment } = assembly();
  const motion = createExplodedView(root);
  motion.setExpanded(true);
  motion.update(1);
  motion.dispose();
  assert.deepEqual(attachment.position.toArray(), [0, 3, 0]);
  assert.equal(motion.canExplode, false);
  assert.equal(motion.setExpanded(true), false);
  assert.equal(motion.update(1), false);
});
