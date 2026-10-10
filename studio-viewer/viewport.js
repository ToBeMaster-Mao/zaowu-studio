import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { createOrientationControl, viewDirections } from './orientation-control.js';
import { summarizeMaterialColor } from './material-color.js';
import { createPreviewMaterials } from './preview-materials.js';
import { createExplodedView } from './exploded-view.js';

// Executed only in an opaque-origin sandbox. The bridge and workspace APIs live
// in the parent; this module exchanges explicit, serializable viewport commands.
const mount = document.getElementById('viewport');
const notice = document.getElementById('notice');
const noticeText = document.getElementById('notice-text');
const post = (type, payload = {}, transfer = []) => window.parent.postMessage({ source: 'model-studio-viewport', type, ...payload }, '*', transfer);
const limits = { objects: 15000, vertices: 2000000, indices: 12000000, extent: 100000 };
const byId = new Map(), idByObject = new WeakMap();
let renderer, scene, camera, controls, root, mixer, environment, ground, grid, outline, resizeObserver, orientationControl;
let previewMaterials, explodedView;
let animations = [], meshes = [], parts = [], fitPoints = [], bounds, size, center, selectedId = null;
let ready = false, disposed = false, wireframe = false, animate = false, currentView = 'perspective';
let previousTime = performance.now(), pointerStart = null, cameraTimer = null;
let background = (document.documentElement.dataset.background || new URLSearchParams(window.location.search).get('background')) === 'light' ? 'light' : 'dark';
let explosionFitPending = false;
const pending = [];
const categoryMatchers = [
  ['cockpit', /cockpit|windscreen|windshield|驾驶舱|风挡/i],
  ['landing-gear', /landing.gear|nose.(gear|oleo|upper.strut|drag.brace|axle|wheel)|main.(gear|wheel)|tyre|tire|起落架|轮胎/i],
  ['engines', /engine|nacelle|fan|spinner|exhaust|pylon|发动机|引擎|扇叶/i],
  ['tail', /tail|fin|rudder|stabilizer|elevator|尾翼/i],
  ['wings', /wing|flap|spoiler|机翼|襟翼/i],
  ['cabin', /window|door|cabin|舷窗|舱门/i],
  ['fuselage', /fuselage|body|belly|机身/i],
];

function fail(error, requestId) {
  const message = String(error?.message || error || '未知错误').slice(0, 1000);
  if (!ready) {
    notice.hidden = false;
    notice.classList.add('error');
    noticeText.textContent = `模型暂时无法预览：${message}`;
  }
  post('error', { message, ...(requestId ? { requestId } : {}) });
}

function isFiniteVector(value) {
  return Array.isArray(value) && value.length === 3 && value.every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= limits.extent);
}

function classify(object) {
  const ancestry = [];
  let aircraftContext = false;
  for (let node = object; node; node = node.parent) {
    // An explicit category on the part or its nearest ancestor takes priority.
    const category = node.userData?.category;
    if (typeof category === 'string' && category.trim()) return category.trim();
    ancestry.push(node.name);
    const modelType = String(node.userData?.modelType || '').toLowerCase();
    if (/^(aircraft|airliner|airplane|aeroplane)$/.test(modelType)
      || /(?:^|[\s_-])(?:aircraft|airliner|airplane|aeroplane)(?:$|[\s_-])|飞机|客机|战机/i.test(node.name || '')) aircraftContext = true;
    if (node === root) break;
  }
  // These matchers describe the aircraft example. Words such as "body", "fan"
  // or "fin" also occur in cups, lamps and furniture, so they need that context.
  if (!aircraftContext) return 'details';
  return categoryMatchers.find(([, expression]) => expression.test(ancestry.join(' ')))?.[0] || 'details';
}

function materialsOf(object) {
  return object.material ? (Array.isArray(object.material) ? object.material : [object.material]) : [];
}

function visibleInHierarchy(object) {
  for (let node = object; node; node = node.parent) if (!node.visible) return false;
  return true;
}

function describePart(id, object) {
  return {
    id, name: object.name || (object.isMesh ? 'Unnamed mesh' : 'Group'),
    parentId: idByObject.get(object.parent) || null,
    kind: object.isMesh ? 'mesh' : 'group', category: classify(object),
    visible: object.visible, position: (explodedView?.getRestPosition(object) || object.position).toArray(),
    ...summarizeMaterialColor(object, part => previewMaterials?.getOriginalMaterial(part) ?? part.material),
  };
}

function validateAndIndex(modelRoot) {
  if (!(modelRoot instanceof THREE.Object3D)) throw new Error('createModel() 必须返回 { root: THREE.Object3D }。');
  let objectCount = 0, vertices = 0, triangles = 0, indices = 0;
  const visited = new Set();
  const stack = [{ object: modelRoot, path: modelRoot.isMesh ? `/${encodeURIComponent(modelRoot.name || 'Model')}` : '' }];
  while (stack.length) {
    const { object, path } = stack.pop();
    if (visited.has(object)) throw new Error('模型层级包含循环或重复对象。');
    visited.add(object);
    if (++objectCount > limits.objects) throw new Error('模型部件过多，当前预览上限为 15,000 个对象。');
    if (![...object.position, ...object.scale, ...object.quaternion].every(Number.isFinite)) throw new Error('模型包含无效的对象变换。');
    if ((object !== modelRoot && object.isGroup) || object.isMesh) {
      byId.set(path, object);
      idByObject.set(object, path);
    }
    if (object.isMesh) {
      const geometry = object.geometry;
      const positions = geometry?.attributes?.position;
      if (!geometry?.isBufferGeometry || !positions || positions.itemSize !== 3) throw new Error(`部件 ${object.name} 缺少有效顶点。`);
      vertices += positions.count;
      indices += geometry.index?.count || 0;
      if (vertices > limits.vertices || indices > limits.indices) throw new Error('模型超出当前视口的 200 万顶点 / 1,200 万索引限制。');
      for (let i = 0; i < positions.count; i++) {
        const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i);
        if (![x, y, z].every(n => Number.isFinite(n) && Math.abs(n) <= limits.extent)) throw new Error(`部件 ${object.name} 包含无效或过大的顶点。`);
      }
      if (geometry.index) {
        for (let i = 0; i < geometry.index.count; i++) {
          const index = geometry.index.getX(i);
          if (!Number.isInteger(index) || index < 0 || index >= positions.count) throw new Error(`部件 ${object.name} 包含无效网格索引。`);
        }
      }
      triangles += (geometry.index?.count ?? positions.count) / 3;
      meshes.push(object);
    }
    const counts = new Map();
    const children = object.children.map((child, index) => {
      const label = encodeURIComponent(child.name || `${child.type}_${index}`).replaceAll('~', '%7E');
      const ordinal = counts.get(label) || 0;
      counts.set(label, ordinal + 1);
      return { object: child, path: `${path}/${label}${ordinal ? `~${ordinal}` : ''}` };
    });
    stack.push(...children.reverse());
  }
  if (!meshes.some(object => object.castShadow)) {
    for (const object of meshes) if (materialsOf(object).every(material => !material.transparent)) object.castShadow = true;
  }
  modelRoot.updateMatrixWorld(true);
  bounds = new THREE.Box3().setFromObject(modelRoot);
  // Empty starter projects are valid, editable scenes.
  if (!meshes.length && bounds.isEmpty()) bounds.set(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1));
  if (bounds.isEmpty() || ![...bounds.min, ...bounds.max].every(n => Number.isFinite(n) && Math.abs(n) <= limits.extent)) throw new Error('模型的空间范围无效或过大。');
  size = bounds.getSize(new THREE.Vector3());
  center = bounds.getCenter(new THREE.Vector3());
  if (size.length() < 0.000001) throw new Error('模型尺寸为零。');
  for (const object of meshes) {
    if (!object.geometry.boundingBox) object.geometry.computeBoundingBox();
    const box = object.geometry.boundingBox;
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      fitPoints.push(new THREE.Vector3(x, y, z).applyMatrix4(object.matrixWorld));
    }
  }
  parts = [...byId].map(([id, object]) => describePart(id, object));
  return { meshes: meshes.length, vertices, triangles: Math.round(triangles) };
}

function cameraState() {
  return { position: camera.position.toArray(), target: controls.target.toArray(), up: camera.up.toArray(), view: currentView };
}

function selectionState() {
  const object = byId.get(selectedId);
  return object ? { ...describePart(selectedId, object), partId: selectedId } : null;
}

function select(partId, notify = true) {
  selectedId = byId.has(partId) ? partId : null;
  const object = byId.get(selectedId);
  outline.visible = Boolean(object && visibleInHierarchy(object));
  if (object) outline.setFromObject(object);
  if (notify) post('selection', { partId: selectedId, name: object?.name || null, position: object ? (explodedView?.getRestPosition(object) || object.position).toArray() : null, camera: cameraState(), selection: selectionState() });
}

const directions = Object.fromEntries(Object.entries(viewDirections).map(([view, direction]) => [view, new THREE.Vector3(...direction)]));

function fit(view = 'perspective') {
  if (!(view in directions) && view !== 'cockpit' && view !== 'engine' && view !== 'custom') return;
  // Discard the previous drag's damping before a deliberate view switch.
  const damping = controls.enableDamping;
  controls.enableDamping = false;
  controls.update();
  controls.enableDamping = damping;
  currentView = view;
  const expanded = explodedView?.expanded || explodedView?.moving;
  let box = expanded ? new THREE.Box3().setFromObject(root) : bounds.clone();
  let direction = view === 'custom' ? camera.position.clone().sub(controls.target).normalize()
    : (directions[view] || directions.perspective).clone().normalize();
  if (view === 'cockpit' || view === 'engine') {
    const expression = view === 'cockpit' ? /cockpit|windscreen|windshield|驾驶舱|风挡/i : /^(Engine_1|Engine_R|Engine_right)$/i;
    let candidates = [...byId.values()].filter(object => expression.test(object.name));
    if (!candidates.length && view === 'engine') candidates = [...byId.values()].filter(object => /engine|nacelle|发动机/i.test(object.name)).slice(0, 1);
    if (candidates.length) {
      box = new THREE.Box3();
      for (const object of candidates) box.union(new THREE.Box3().setFromObject(object));
      box.expandByScalar(Math.max(box.getSize(new THREE.Vector3()).length() * .16, size.length() * .012));
      direction = (view === 'cockpit' ? new THREE.Vector3(-1, .28, .6) : new THREE.Vector3(-1, .38, 1)).normalize();
    }
  }
  const target = box.getCenter(new THREE.Vector3());
  if (view !== 'custom') camera.up.set(0, 1, 0);
  if (view === 'top' || view === 'bottom') camera.up.set(-1, 0, 0);
  const right = new THREE.Vector3().crossVectors(camera.up, direction).normalize();
  const up = new THREE.Vector3().crossVectors(direction, right).normalize();
  const tangent = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  let distance = 0;
  const points = !expanded && view in directions && fitPoints.length ? fitPoints : [];
  if (!points.length) for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) points.push(new THREE.Vector3(x, y, z));
  for (const worldPoint of points) {
    const point = worldPoint.clone().sub(target);
    const depth = point.dot(direction);
    distance = Math.max(distance, Math.abs(point.dot(right)) / (tangent * camera.aspect) + depth, Math.abs(point.dot(up)) / tangent + depth);
  }
  controls.target.copy(target);
  // Leave breathing room around the model beneath the viewport controls.
  camera.position.copy(target).addScaledVector(direction, distance * 1.2);
  camera.lookAt(target);
  controls.update();
  post('camera', cameraState());
}

function setWireframe(value) {
  wireframe = Boolean(value);
  previewMaterials.setWireframe(wireframe);
}

function setBackground(value) {
  background = value === 'light' ? 'light' : 'dark';
  const light = background === 'light';
  document.documentElement.dataset.background = background;
  if (scene) scene.background = new THREE.Color(light ? '#e9ecef' : '#16191d');
  if (ground) {
    ground.material.color.set(light ? '#53606a' : '#020306');
    ground.material.opacity = light ? .18 : .32;
  }
  if (grid) {
    grid.material.color.set(light ? '#52606c' : '#ffffff');
    grid.material.opacity = light ? .2 : .27;
  }
}

function displayState() {
  post('displayState', { background, clay: previewMaterials.clay, exploded: Boolean(explodedView?.expanded), animate });
}

function setExploded(value) {
  if (!explodedView.canExplode) return;
  if (Boolean(value) && animate) {
    animate = false;
    mixer.setTime(0);
  }
  explodedView.setExpanded(Boolean(value));
  explosionFitPending = true;
  displayState();
}

function setPart(data) {
  const object = byId.get(data.partId);
  if (!object) throw new Error('该部件已不存在，请重新选择。');
  if (typeof data.visible === 'boolean') object.visible = data.visible;
  if (data.position !== undefined) {
    if (!isFiniteVector(data.position)) throw new Error('部件坐标必须是三个有效数值。');
    explodedView.setRestPosition(object, data.position);
  }
  if (data.color !== undefined) {
    if (typeof data.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(data.color)) throw new Error('材质颜色须使用 #RRGGBB 格式。');
    previewMaterials.setColor(object, data.color);
  }
  root.updateMatrixWorld(true);
  if (selectedId) select(selectedId, false);
  parts = [...byId].map(([id, part]) => describePart(id, part));
  post('partChanged', { partId: data.partId, part: describePart(data.partId, object), parts, selection: selectionState() });
}

let exporting = false;
async function handleCommand(data) {
  if (exporting) { if (pending.length < 30) pending.push(data); return; }
  try {
    switch (data.type) {
      case 'view': fit(data.view); break;
      case 'wireframe': setWireframe(data.value); break;
      case 'background': setBackground(data.value); displayState(); break;
      case 'clay': previewMaterials.setClay(data.value); displayState(); break;
      case 'explode': setExploded(data.value); break;
      case 'grid': grid.visible = Boolean(data.value); break;
      case 'animate':
        if (data.value && explodedView.expanded) { explodedView.setExpanded(false); explosionFitPending = true; }
        animate = Boolean(data.value);
        displayState();
        break;
      case 'select': select(data.partId); break;
      case 'setPart': setPart(data); break;
      case 'requestState': post('state', { requestId: data.requestId, camera: cameraState(), selection: selectionState(), parts }); break;
      case 'screenshot':
        renderer.render(scene, camera);
        post('screenshot', { requestId: data.requestId, dataUrl: renderer.domElement.toDataURL('image/png') });
        break;
      case 'export': {
        if (exporting) throw new Error('另一个导出任务正在进行。');
        exporting = true;
        const wasAnimating = animate;
        animate = false;
        try {
          const buffer = await explodedView.withRestPose(() => previewMaterials.withOriginalMaterials(() =>
            new GLTFExporter().parseAsync(root, { binary: true, animations, onlyVisible: true, trs: true })));
          post('export', { requestId: data.requestId, buffer }, [buffer]);
        } finally {
          exporting = false;
          animate = wasAnimating;
          for (const queued of pending.splice(0)) await handleCommand(queued);
        }
        break;
      }
    }
  } catch (error) { fail(error, data.requestId); }
}

window.addEventListener('message', event => {
  if (event.source !== window.parent || !event.data || event.data.source !== 'model-studio' || disposed) return;
  const data = event.data;
  if (typeof data.type !== 'string') return;
  if (!ready && data.type === 'background') { setBackground(data.value); return; }
  if (!ready) { if (pending.length < 30) pending.push(data); return; }
  handleCommand(data);
});

function dispose() {
  if (disposed) return;
  disposed = true;
  clearTimeout(cameraTimer);
  resizeObserver?.disconnect();
  renderer?.setAnimationLoop(null);
  orientationControl?.dispose();
  controls?.dispose();
  mixer?.stopAllAction();
  if (root) mixer?.uncacheRoot(root);
  explodedView?.dispose();
  previewMaterials?.dispose();
  const geometries = new Set(), materials = new Set(), textures = new Set();
  const collect = object => {
    if (object.geometry) geometries.add(object.geometry);
    for (const material of materialsOf(object)) materials.add(material);
    if (object.shadow) object.shadow.dispose();
  };
  scene?.traverse(collect);
  // A module can fail validation before its root is attached to the scene.
  if (root instanceof THREE.Object3D && root.parent !== scene) root.traverse(collect);
  for (const material of previewMaterials?.getOriginalMaterials() || []) materials.add(material);
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) {
    for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    material.dispose();
  }
  for (const texture of textures) texture.dispose();
  environment?.dispose();
  renderer?.dispose();
}
window.addEventListener('pagehide', dispose, { once: true });

async function start() {
  const modelParameter = new URLSearchParams(window.location.search).get('model');
  if (!modelParameter) throw new Error('没有指定项目模型。');
  const url = new URL(modelParameter, window.location.href);
  if (url.origin !== new URL(window.location.href).origin || !/^\/artifacts\/[a-zA-Z0-9_-]+\/model\.js$/.test(url.pathname)) throw new Error('模型地址必须来自当前项目的 artifacts 目录。');
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  mount.appendChild(renderer.domElement);
  renderer.domElement.setAttribute('aria-label', '三维模型，可拖动旋转');
  renderer.domElement.addEventListener('webglcontextlost', event => { event.preventDefault(); fail(new Error('图形上下文已中断，请重新载入模型。')); });
  scene = new THREE.Scene();
  setBackground(background);
  camera = new THREE.PerspectiveCamera(33, 1, .01, 10000);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = .08;
  controls.maxPolarAngle = Math.PI;
  controls.addEventListener('start', () => { currentView = 'custom'; });
  controls.addEventListener('end', () => {
    clearTimeout(cameraTimer);
    cameraTimer = setTimeout(() => { if (ready && !disposed) post('camera', cameraState()); }, 150);
  });
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  environment = pmrem.fromScene(room, .05);
  scene.environment = environment.texture;
  scene.environmentIntensity = .65;
  room.dispose();
  pmrem.dispose();
  const modelModule = await import(url.href);
  if (typeof modelModule.createModel !== 'function') throw new Error('model.js 必须导出 createModel()。');
  const model = await modelModule.createModel();
  root = model?.root;
  const stats = validateAndIndex(root);
  previewMaterials = createPreviewMaterials(root);
  explodedView = createExplodedView(root);
  animations = Array.isArray(model.animations) ? model.animations.filter(clip => clip instanceof THREE.AnimationClip) : [];
  scene.add(root);
  const extent = Math.max(size.x, size.y, size.z);
  // Keep depth precision high enough for thin window and panel overlays.
  camera.near = Math.max(extent / 500, .002);
  camera.far = extent * 30;
  camera.updateProjectionMatrix();
  controls.minDistance = extent * .015;
  controls.maxDistance = extent * 12;
  const key = new THREE.DirectionalLight('#fff6eb', 2.4);
  key.position.copy(center).add(new THREE.Vector3(-.45, 1.15, .65).multiplyScalar(extent));
  key.target.position.copy(center);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.radius = 4;
  Object.assign(key.shadow.camera, { left: -extent * .7, right: extent * .7, top: extent * .7, bottom: -extent * .7, near: extent * .05, far: extent * 4 });
  key.shadow.bias = -.0002;
  key.shadow.normalBias = extent * .00065;
  scene.add(key, key.target);
  const fill = new THREE.DirectionalLight('#d8e7fa', 1.1);
  fill.position.copy(center).add(new THREE.Vector3(.5, .8, -1).multiplyScalar(extent));
  scene.add(fill);
  ground = new THREE.Mesh(new THREE.PlaneGeometry(extent * 50, extent * 50), new THREE.ShadowMaterial({ color: '#020306', opacity: .32 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(center.x, bounds.min.y - extent * .001, center.z);
  ground.receiveShadow = true;
  scene.add(ground);
  grid = new THREE.GridHelper(extent * 4, 60, '#515963', '#343b43');
  grid.position.set(center.x, ground.position.y + extent * .0001, center.z);
  grid.material.transparent = true;
  grid.material.opacity = .27;
  grid.visible = false;
  scene.add(grid);
  setBackground(background);
  outline = new THREE.BoxHelper(undefined, '#c4eb7b');
  outline.material.depthTest = false;
  outline.material.transparent = true;
  outline.material.opacity = .72;
  outline.renderOrder = 10;
  outline.visible = false;
  scene.add(outline);
  mixer = new THREE.AnimationMixer(root);
  for (const clip of animations) mixer.clipAction(clip).play();
  const raycaster = new THREE.Raycaster();
  renderer.domElement.addEventListener('pointerdown', event => { if (event.button === 0) pointerStart = { x: event.clientX, y: event.clientY }; });
  renderer.domElement.addEventListener('pointerup', event => {
    if (!pointerStart || event.button !== 0) return;
    const moved = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y);
    pointerStart = null;
    if (moved > 5) return;
    const rect = renderer.domElement.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), camera);
    const intersection = raycaster.intersectObjects(meshes, false).find(hit => visibleInHierarchy(hit.object));
    select(intersection ? idByObject.get(intersection.object) : null);
  });
  renderer.domElement.addEventListener('pointercancel', () => { pointerStart = null; });
  function resize() {
    const width = Math.max(mount.clientWidth, 1), height = Math.max(mount.clientHeight, 1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (!ready) fit(currentView);
  }
  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(mount);
  resize();
  fit('perspective');
  orientationControl = createOrientationControl({ camera, onView: fit });
  renderer.render(scene, camera);
  notice.hidden = true;
  ready = true;
  post('ready', { stats, parts, bounds: { min: bounds.min.toArray(), max: bounds.max.toArray(), center: center.toArray(), size: size.toArray() }, camera: cameraState(), animationCount: animations.length, canExplode: explodedView.canExplode });
  renderer.setAnimationLoop(time => {
    const delta = Math.min((time - previousTime) / 1000, .05);
    previousTime = time;
    if (exporting) return;
    if (animate && !explodedView.expanded && !explodedView.moving) mixer.update(delta);
    explodedView.update(delta);
    if (explosionFitPending && !explodedView.moving) {
      explosionFitPending = false;
      fit(currentView);
    }
    controls.update();
    orientationControl.update();
    if (selectedId && outline.visible) outline.update();
    renderer.render(scene, camera);
  });
  for (const data of pending.splice(0)) await handleCommand(data);
}

start().catch(error => { fail(error); dispose(); });
