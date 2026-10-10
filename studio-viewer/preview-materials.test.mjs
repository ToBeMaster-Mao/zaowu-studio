import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createPreviewMaterials } from './preview-materials.js';
import { summarizeMaterialColor } from './material-color.js';

test('white preview strips textures, vertex tints and transmission, then restores exact shared material references', () => {
  const root = new THREE.Group();
  const texture = new THREE.Texture();
  const original = new THREE.MeshPhysicalMaterial({ color: '#902030', map: texture, normalMap: texture, vertexColors: true, transmission: .9, metalness: 1, transparent: true, opacity: .4, side: THREE.DoubleSide });
  const materials = [original, original];
  const first = new THREE.Mesh(new THREE.BoxGeometry(), original);
  const second = new THREE.Mesh(new THREE.BoxGeometry(), materials);
  root.add(first, second);
  const preview = createPreviewMaterials(root);
  preview.setClay(true);
  assert.equal(first.material.color.getHexString(), 'c7cbcf');
  assert.equal(first.material.map, null);
  assert.equal(first.material.normalMap, null);
  assert.equal(first.material.vertexColors, false);
  assert.equal(first.material.transparent, false);
  assert.equal(first.material.opacity, 1);
  assert.equal(first.material.metalness, 0);
  assert.equal(first.material.side, THREE.DoubleSide);
  assert.strictEqual(second.material[0], first.material);
  preview.setClay(false);
  assert.strictEqual(first.material, original);
  assert.strictEqual(second.material, materials);
  assert.equal(original.color.getHexString(), '902030');
  assert.strictEqual(original.map, texture);
});

test('editing a white part changes its source material without recoloring other shared-material parts', () => {
  const root = new THREE.Group();
  const original = new THREE.MeshStandardMaterial({ color: '#234567' });
  const first = new THREE.Mesh(new THREE.BoxGeometry(), original);
  const second = new THREE.Mesh(new THREE.BoxGeometry(), original);
  root.add(first, second);
  const preview = createPreviewMaterials(root);
  preview.setClay(true);
  preview.setColor(first, '#ffaa22');
  assert.equal(first.material.color.getHexString(), 'c7cbcf');
  assert.deepEqual(summarizeMaterialColor(first, preview.getOriginalMaterial), { color: '#ffaa22', colorState: 'uniform' });
  assert.equal(first.material.color.getHexString(), 'c7cbcf');
  preview.setClay(false);
  assert.equal(first.material.color.getHexString(), 'ffaa22');
  assert.strictEqual(second.material, original);
  assert.equal(second.material.color.getHexString(), '234567');
});

test('source-material export removes inspection wireframe and restores white preview even after rejection', async () => {
  const original = new THREE.MeshStandardMaterial({ color: '#224466' });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), original);
  const preview = createPreviewMaterials(mesh);
  preview.setWireframe(true);
  preview.setClay(true);
  const white = mesh.material;
  await assert.rejects(preview.withOriginalMaterials(async () => {
    assert.strictEqual(mesh.material, original);
    assert.equal(mesh.material.wireframe, false);
    await Promise.resolve();
    throw new Error('Export failed');
  }), /Export failed/);
  assert.strictEqual(mesh.material, white);
  assert.equal(mesh.material.wireframe, true);
  preview.setWireframe(false);
  assert.equal(mesh.material.wireframe, false);
  preview.dispose();
  assert.strictEqual(mesh.material, original);
  assert.equal(original.wireframe, false);
});

test('white and wireframe controls preserve wireframe authored into the model', () => {
  const original = new THREE.MeshStandardMaterial({ wireframe: true });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), original);
  const preview = createPreviewMaterials(mesh);
  preview.setClay(true);
  preview.setWireframe(true);
  preview.setWireframe(false);
  assert.equal(mesh.material.wireframe, true);
  preview.setClay(false);
  assert.equal(original.wireframe, true);
});
