import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { orientationAxes, projectOrientation, viewDirections } from './orientation-control.js';

test('the six selectable directions match the modeling contract and face the camera', () => {
  const camera = new THREE.PerspectiveCamera();
  const output = orientationAxes.map(() => new THREE.Vector3());
  assert.deepEqual(orientationAxes.find(axis => axis.view === 'front').vector, [-1, 0, 0]);
  for (const axis of orientationAxes) {
    camera.position.fromArray(viewDirections[axis.view]);
    camera.up.set(0, 1, 0);
    if (axis.axis === 'y') camera.up.set(-1, 0, 0);
    camera.lookAt(0, 0, 0);
    projectOrientation(camera.quaternion, output);
    const index = orientationAxes.indexOf(axis);
    assert.ok(output[index].z > .999999, `${axis.view} should project toward the viewer`);
    assert.ok(Math.hypot(output[index].x, output[index].y) < .0001);
    const opposite = orientationAxes.findIndex(other => other.axis === axis.axis && other.sign !== axis.sign);
    assert.ok(output[opposite].z < -.999999);
  }
});

test('projection follows camera rotation and reuses its output vectors', () => {
  const output = orientationAxes.map(() => new THREE.Vector3());
  const references = [...output];
  const inverse = new THREE.Quaternion();
  projectOrientation(new THREE.Quaternion(), output, inverse);
  assert.deepEqual(output[0].toArray(), [1, 0, 0]);
  const quaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  assert.strictEqual(projectOrientation(quaternion, output, inverse), output);
  assert.ok(output[0].z > .999999);
  assert.ok(Math.abs(output[0].x) < 1e-10);
  assert.ok(output[4].x < -.999999);
  output.forEach((vector, index) => {
    assert.strictEqual(vector, references[index]);
    assert.ok(Math.abs(vector.length() - 1) < 1e-10);
  });
});
