import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { summarizeMaterialColor } from './material-color.js';

const mesh = color => new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ color }));

test('nested groups report their common material base color', () => {
  const group = new THREE.Group();
  const nested = new THREE.Group();
  nested.add(mesh('#abc123'));
  group.add(mesh('#abc123'), nested);
  assert.deepEqual(summarizeMaterialColor(group), { color: '#abc123', colorState: 'uniform' });
});

test('a group reports mixed colors and stops inspecting after the second distinct color', () => {
  const group = new THREE.Group();
  const unvisited = mesh('#000000');
  unvisited.material.color.getHexString = () => { throw new Error('Traversal should already have stopped'); };
  group.add(unvisited, mesh('#112233'), mesh('#ffffff'));
  assert.deepEqual(summarizeMaterialColor(group), { color: null, colorState: 'mixed' });
});

test('empty groups and materials without base colors are unavailable, while colorless materials are ignored', () => {
  const group = new THREE.Group();
  assert.deepEqual(summarizeMaterialColor(group), { color: null, colorState: 'unavailable' });
  group.add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshNormalMaterial()));
  assert.deepEqual(summarizeMaterialColor(group), { color: null, colorState: 'unavailable' });
  group.add(mesh('#778899'));
  assert.deepEqual(summarizeMaterialColor(group), { color: '#778899', colorState: 'uniform' });
});

test('mesh material arrays distinguish common and mixed colors without mutating their materials', () => {
  const colored = new THREE.MeshStandardMaterial({ color: '#345678' });
  const same = colored.clone();
  const different = new THREE.MeshStandardMaterial({ color: '#ff6600' });
  const colorless = new THREE.MeshNormalMaterial();
  const materials = [colored, colorless, same];
  const object = new THREE.Mesh(new THREE.BufferGeometry(), materials);
  const before = materials.map(material => material.toJSON());
  assert.deepEqual(summarizeMaterialColor(object), { color: '#345678', colorState: 'uniform' });
  assert.strictEqual(object.material, materials);
  assert.deepEqual(materials.map(material => material.toJSON()), before);
  materials.push(different);
  assert.deepEqual(summarizeMaterialColor(object), { color: null, colorState: 'mixed' });
  assert.strictEqual(materials[0], colored);
  assert.equal(colored.color.getHexString(), '345678');
  assert.equal(different.color.getHexString(), 'ff6600');
});
