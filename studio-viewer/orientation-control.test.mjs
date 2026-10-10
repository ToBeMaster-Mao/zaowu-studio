import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { orientationAxes, orientationCubeVertices, orientationFaces, projectOrientation, projectOrientationCube, viewDirections } from './orientation-control.js';

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

test('cube faces wind outward and pair their labels with the model view contract', () => {
  const expected = { front: '正', back: '背', top: '顶', bottom: '底', side: '右', 'opposite-side': '左' };
  for (const face of orientationFaces) {
    assert.equal(face.label, expected[face.view]);
    const points = face.vertices.map(index => new THREE.Vector3(...orientationCubeVertices[index]));
    const normal = points[1].clone().sub(points[0]).cross(points[2].clone().sub(points[0])).normalize();
    assert.ok(normal.distanceTo(new THREE.Vector3(...face.vector)) < 1e-10, `${face.view} must face outward`);
    const center = points.reduce((sum, point) => sum.add(point), new THREE.Vector3()).multiplyScalar(.25);
    assert.ok(center.distanceTo(normal) < 1e-10, `${face.view} label belongs at the center of its face`);
  }
});

test('cube projection shows the expected faces at perspective and each aligned view', () => {
  const camera = new THREE.PerspectiveCamera();
  const vertices = orientationCubeVertices.map(() => new THREE.Vector3());
  const normals = orientationAxes.map(() => new THREE.Vector3());
  const originalVertices = [...vertices];
  const lookFrom = view => {
    camera.position.fromArray(viewDirections[view]);
    camera.up.set(...(['top', 'bottom'].includes(view) ? [-1, 0, 0] : [0, 1, 0]));
    camera.lookAt(0, 0, 0);
    assert.strictEqual(projectOrientationCube(camera.quaternion, vertices, normals), vertices);
    return orientationFaces.filter((_, index) => normals[index].z > .025).map(face => face.view);
  };
  assert.deepEqual(lookFrom('perspective'), ['front', 'top', 'side']);
  assert.ok(normals[1].x < 0, 'front occupies the left half of the default cube');
  assert.ok(normals[4].x > 0, 'right occupies the right half of the default cube');
  assert.ok(normals[2].y > 0, 'top occupies the upper half of the default cube');
  for (const face of orientationFaces) {
    assert.deepEqual(lookFrom(face.view), [face.view]);
    const center = face.vertices.reduce((sum, index) => sum.add(vertices[index]), new THREE.Vector3()).multiplyScalar(.25);
    assert.ok(center.distanceTo(normals[orientationFaces.indexOf(face)]) < 1e-10);
  }
  vertices.forEach((vector, index) => assert.strictEqual(vector, originalVertices[index]));
});
