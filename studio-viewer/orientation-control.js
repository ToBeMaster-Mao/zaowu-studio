import * as THREE from 'three';

// The modeling contract faces -X. Keep these labels consistent with fit().
export const orientationAxes = Object.freeze([
  { axis: 'x', sign: 1, vector: [1, 0, 0], label: 'X', view: 'back', name: '背面' },
  { axis: 'x', sign: -1, vector: [-1, 0, 0], label: '−X', view: 'front', name: '正面' },
  { axis: 'y', sign: 1, vector: [0, 1, 0], label: 'Y', view: 'top', name: '顶面' },
  { axis: 'y', sign: -1, vector: [0, -1, 0], label: '−Y', view: 'bottom', name: '底面' },
  { axis: 'z', sign: 1, vector: [0, 0, 1], label: 'Z', view: 'side', name: '侧面' },
  { axis: 'z', sign: -1, vector: [0, 0, -1], label: '−Z', view: 'opposite-side', name: '另一侧' },
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

export function createOrientationControl({ camera, container = document.body, onView }) {
  const element = document.createElement('section');
  element.className = 'orientation-control';
  element.setAttribute('aria-label', '三维视角控制');
  element.innerHTML = `<div class="orientation-heading"><span>视角</span><button class="orientation-reset" type="button" aria-label="复位到透视视角" title="复位到透视视角"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.1 7.2A6.1 6.1 0 1 1 4 12.5M4 3.7v3.8h3.8"/></svg></button></div><div class="orientation-compass"><svg class="orientation-lines" viewBox="0 0 116 106" aria-hidden="true"><circle class="orientation-orbit" cx="58" cy="53" r="36"/><g></g><circle class="orientation-origin" cx="58" cy="53" r="2.5"/></svg></div><div class="orientation-shortcuts" aria-label="常用视角"><button type="button" data-view="front">正</button><button type="button" data-view="side">侧</button><button type="button" data-view="top">顶</button></div>`;
  const compass = element.querySelector('.orientation-compass');
  const lineGroup = element.querySelector('.orientation-lines g');
  const nodes = orientationAxes.map(axis => {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.classList.add('orientation-ray', `axis-${axis.axis}`);
    line.setAttribute('x1', '58');
    line.setAttribute('y1', '53');
    lineGroup.appendChild(line);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `orientation-axis axis-${axis.axis}${axis.sign < 0 ? ' is-negative' : ''}`;
    button.dataset.view = axis.view;
    button.setAttribute('aria-label', `切换到${axis.name}（${axis.sign > 0 ? '+' : '−'}${axis.axis.toUpperCase()} 轴）`);
    button.title = `${axis.name} · ${axis.sign > 0 ? '+' : '−'}${axis.axis.toUpperCase()}`;
    button.innerHTML = `<span>${axis.label}</span>`;
    compass.appendChild(button);
    return { button, line, axis };
  });
  const shortcuts = [...element.querySelectorAll('.orientation-shortcuts button')];
  shortcuts.forEach(button => button.setAttribute('aria-label', `切换到${{ front: '正面', side: '侧面', top: '顶面' }[button.dataset.view]}`));
  const onClick = event => {
    const button = event.target.closest('button');
    if (!button || !element.contains(button)) return;
    onView(button.classList.contains('orientation-reset') ? 'perspective' : button.dataset.view);
  };
  element.addEventListener('click', onClick);
  container.appendChild(element);
  const projected = orientationAxes.map(() => new THREE.Vector3());
  const inverse = new THREE.Quaternion();
  const previous = new THREE.Quaternion(0, 0, 0, 0);
  let disposed = false;
  function update() {
    if (disposed || 1 - Math.abs(previous.dot(camera.quaternion)) < 1e-10) return;
    previous.copy(camera.quaternion);
    projectOrientation(camera.quaternion, projected, inverse);
    let alignedView = null;
    for (let i = 0; i < nodes.length; i++) {
      const { button, line, axis } = nodes[i];
      const point = projected[i];
      let x = 58 + point.x * 35, y = 53 - point.y * 35;
      // At an exact axis view the near/far poles overlap. Move only the far
      // button aside so both directions remain reachable with a pointer.
      if (point.z < -.94) { x -= 27; y += 15; }
      button.style.transform = `translate(${x.toFixed(2)}px,${y.toFixed(2)}px)`;
      button.style.zIndex = String(Math.round((point.z + 1) * 10) + 1);
      button.classList.toggle('is-back', point.z < -.08);
      const aligned = point.z > .9995;
      button.classList.toggle('is-aligned', aligned);
      button.setAttribute('aria-pressed', String(aligned));
      line.setAttribute('x2', x.toFixed(2));
      line.setAttribute('y2', y.toFixed(2));
      line.style.opacity = point.z < -.08 ? '.25' : '.62';
      if (aligned) alignedView = axis.view;
    }
    for (const button of shortcuts) {
      const active = button.dataset.view === alignedView;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
  }
  update();
  return {
    update,
    dispose() {
      if (disposed) return;
      disposed = true;
      element.removeEventListener('click', onClick);
      element.remove();
    },
  };
}
