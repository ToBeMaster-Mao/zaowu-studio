import * as THREE from 'three';

// The modeling contract faces -X. Keep these labels consistent with fit().
export const orientationAxes = Object.freeze([
  { axis: 'x', sign: 1, vector: [1, 0, 0], label: 'X', view: 'back', name: '背面' },
  { axis: 'x', sign: -1, vector: [-1, 0, 0], label: '−X', view: 'front', name: '正面' },
  { axis: 'y', sign: 1, vector: [0, 1, 0], label: 'Y', view: 'top', name: '顶面' },
  { axis: 'y', sign: -1, vector: [0, -1, 0], label: '−Y', view: 'bottom', name: '底面' },
  { axis: 'z', sign: 1, vector: [0, 0, 1], label: 'Z', view: 'side', name: '右侧' },
  { axis: 'z', sign: -1, vector: [0, 0, -1], label: '−Z', view: 'opposite-side', name: '左侧' },
]);

export const viewDirections = Object.freeze({
  perspective: [-1.22, .69, 1.55],
  front: [-1, .00001, 0],
  back: [1, .00001, 0],
  side: [0, .00001, 1],
  'opposite-side': [0, .00001, -1],
  top: [0, 1, .00001],
  bottom: [0, -1, .00001],
});

/** Project world axes into the camera's local frame without allocating per tick. */
export function projectOrientation(cameraQuaternion, output, inverse = new THREE.Quaternion()) {
  inverse.copy(cameraQuaternion).invert();
  for (let i = 0; i < orientationAxes.length; i++) {
    output[i].fromArray(orientationAxes[i].vector).applyQuaternion(inverse);
  }
  return output;
}

export const orientationCubeVertices = Object.freeze([
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
].map(Object.freeze));

// Counterclockwise winding, viewed from outside the cube. Face order matches
// orientationAxes so projection, pointer targets and view commands stay paired.
export const orientationFaces = Object.freeze([
  { label: '背', vertices: [1, 2, 6, 5] },
  { label: '正', vertices: [0, 4, 7, 3] },
  { label: '顶', vertices: [3, 7, 6, 2] },
  { label: '底', vertices: [0, 1, 5, 4] },
  { label: '右', vertices: [4, 5, 6, 7] },
  { label: '左', vertices: [0, 3, 2, 1] },
].map((face, index) => Object.freeze({
  ...orientationAxes[index], ...face, vertices: Object.freeze(face.vertices),
})));

/** Orthographic cube projection using the viewport's actual camera rotation. */
export function projectOrientationCube(cameraQuaternion, vertices, normals, inverse = new THREE.Quaternion()) {
  projectOrientation(cameraQuaternion, normals, inverse);
  for (let i = 0; i < orientationCubeVertices.length; i++) {
    vertices[i].fromArray(orientationCubeVertices[i]).applyQuaternion(inverse);
  }
  return vertices;
}

export function createOrientationControl({ camera, container = document.body, onView }) {
  const element = document.createElement('section');
  element.className = 'orientation-control';
  element.setAttribute('aria-label', '三维视角控制');
  element.innerHTML = `<svg class="orientation-cube" viewBox="0 0 112 112" role="group" aria-label="点击立方体的面切换视角；复位可返回透视视角"></svg><button class="orientation-reset" type="button" aria-label="复位到透视视角" title="复位到透视视角"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.1 7.2A6.1 6.1 0 1 1 4 12.5M4 3.7v3.8h3.8"/></svg></button>`;
  const cube = element.querySelector('.orientation-cube');
  const namespace = 'http://www.w3.org/2000/svg';
  const nodes = orientationFaces.map(face => {
    const button = document.createElementNS(namespace, 'g');
    button.classList.add('orientation-face', `face-${face.view}`);
    button.dataset.view = face.view;
    button.setAttribute('role', 'button');
    button.setAttribute('tabindex', '0');
    button.setAttribute('aria-label', `切换到${face.name}`);
    const title = document.createElementNS(namespace, 'title');
    title.textContent = `${face.name} · ${face.sign > 0 ? '+' : '−'}${face.axis.toUpperCase()}`;
    const polygon = document.createElementNS(namespace, 'polygon');
    const text = document.createElementNS(namespace, 'text');
    text.textContent = face.label;
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'central');
    text.setAttribute('aria-hidden', 'true');
    button.append(title, polygon, text);
    cube.appendChild(button);
    return { button, polygon, text, face };
  });
  const onClick = event => {
    const button = event.target.closest('[data-view], .orientation-reset');
    if (!button || !element.contains(button)) return;
    onView(button.classList.contains('orientation-reset') ? 'perspective' : button.dataset.view);
  };
  const onKeyDown = event => {
    const button = event.target.closest('.orientation-face');
    if (!button || !element.contains(button) || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    onView(button.dataset.view);
  };
  element.addEventListener('click', onClick);
  element.addEventListener('keydown', onKeyDown);
  container.appendChild(element);
  const projected = orientationAxes.map(() => new THREE.Vector3());
  const vertices = orientationCubeVertices.map(() => new THREE.Vector3());
  const inverse = new THREE.Quaternion();
  const previous = new THREE.Quaternion(0, 0, 0, 0);
  const scale = 26, centerX = 51, centerY = 48;
  let disposed = false;
  function update() {
    if (disposed || 1 - Math.abs(previous.dot(camera.quaternion)) < 1e-10) return;
    previous.copy(camera.quaternion);
    projectOrientationCube(camera.quaternion, vertices, projected, inverse);
    for (let i = 0; i < nodes.length; i++) {
      const { button, polygon, text, face } = nodes[i];
      const normal = projected[i];
      const visible = normal.z > .025;
      button.style.display = visible ? '' : 'none';
      button.setAttribute('tabindex', visible ? '0' : '-1');
      button.setAttribute('aria-hidden', String(!visible));
      const aligned = normal.z > .9995;
      button.classList.toggle('is-aligned', aligned);
      button.setAttribute('aria-pressed', String(aligned));
      if (!visible) continue;
      polygon.setAttribute('points', face.vertices.map(index => {
        const point = vertices[index];
        return `${(centerX + point.x * scale).toFixed(2)},${(centerY - point.y * scale).toFixed(2)}`;
      }).join(' '));
      text.setAttribute('x', (centerX + normal.x * scale).toFixed(2));
      text.setAttribute('y', (centerY - normal.y * scale).toFixed(2));
      // Edge-on faces remain clickable without cramming text into a sliver.
      text.style.opacity = normal.z > .2 ? '1' : '0';
    }
  }
  update();
  return {
    update,
    dispose() {
      if (disposed) return;
      disposed = true;
      element.removeEventListener('click', onClick);
      element.removeEventListener('keydown', onKeyDown);
      element.remove();
    },
  };
}
