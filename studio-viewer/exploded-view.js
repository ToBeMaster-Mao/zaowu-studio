import * as THREE from 'three';

function renderable(object) {
  if (object.isMesh) return true;
  return object.children.some(renderable);
}

function assemblyUnits(root) {
  let container = root;
  // Model importers often add one or more empty wrapper groups. The first
  // branching level is the assembly; its descendants stay with their part.
  while (!container.isMesh) {
    const children = container.children.filter(renderable);
    if (children.length !== 1) return children;
    container = children[0];
  }
  return [];
}

/** Temporary assembly inspection. Never bake its offsets into model edits. */
export function createExplodedView(root, { duration = .7, distance = .32 } = {}) {
  let rigged = false;
  root.traverse(object => { if (object.isSkinnedMesh) rigged = true; });
  root.updateWorldMatrix(true, true);
  const units = (rigged ? [] : assemblyUnits(root)).map(object => ({
    object,
    rest: object.position.clone(),
    matrix: object.matrix.clone(),
    offset: new THREE.Vector3(),
  }));
  const records = new Map(units.map(unit => [unit.object, unit]));
  let progress = 0, target = 0, disposed = false, restDepth = 0, revision = 0;
  let restSnapshot = null;
  let supported = units.length > 1;
  const seconds = Number.isFinite(duration) && duration > 0 ? duration : .7;
  const spacing = Number.isFinite(distance) && distance > 0 ? distance : .32;

  function positionUnit(unit, amount) {
    const { object, rest, offset } = unit;
    object.position.copy(rest).addScaledVector(offset, amount);
    if (object.matrixAutoUpdate) object.updateMatrix();
    else {
      object.matrix.copy(unit.matrix);
      object.matrix.elements[12] += offset.x * amount;
      object.matrix.elements[13] += offset.y * amount;
      object.matrix.elements[14] += offset.z * amount;
      object.matrixWorldNeedsUpdate = true;
    }
  }

  function applyPose(amount = progress * progress * (3 - 2 * progress)) {
    for (const unit of units) positionUnit(unit, amount);
    root.updateWorldMatrix(true, true);
  }

  function measure() {
    root.updateWorldMatrix(true, true);
    const boxes = units.map(unit => new THREE.Box3().setFromObject(unit.object));
    if (boxes.some(box => box.isEmpty())) {
      supported = false;
      return;
    }
    const bounds = new THREE.Box3();
    for (const box of boxes) bounds.union(box);
    const size = bounds.getSize(new THREE.Vector3());
    const extent = Math.max(size.x, size.y, size.z);
    if (!Number.isFinite(extent) || extent <= 0) {
      supported = false;
      return;
    }
    // Keep the main assembly stationary; attachments separate around it.
    const scores = boxes.map(box => box.getSize(new THREE.Vector3()).lengthSq());
    const anchor = scores.indexOf(Math.max(...scores));
    const origin = boxes[anchor].getCenter(new THREE.Vector3());
    supported = units.length > 1;
    units.forEach((unit, index) => {
      unit.offset.set(0, 0, 0);
      if (index === anchor) return;
      const parentMatrix = unit.object.parent?.matrixWorld || new THREE.Matrix4();
      if (!Number.isFinite(parentMatrix.determinant()) || parentMatrix.determinant() === 0) {
        supported = false;
        return;
      }
      const direction = boxes[index].getCenter(new THREE.Vector3()).sub(origin);
      // Coincident mesh origins are common with baked geometry. Geometry
      // centers determine direction, with a stable fallback for equal centers.
      if (direction.lengthSq() < extent * extent * 1e-10) {
        const angle = index * Math.PI * (3 - Math.sqrt(5));
        direction.set(Math.cos(angle), .6 + index / units.length, Math.sin(angle));
      }
      direction.normalize().multiplyScalar(extent * spacing);
      const inverseParent = new THREE.Matrix3().setFromMatrix4(parentMatrix.clone().invert());
      unit.offset.copy(direction).applyMatrix3(inverseParent);
    });
    if (!supported) for (const unit of units) unit.offset.set(0, 0, 0);
  }

  if (supported) measure();

  function updateRestPosition(object, value) {
    const next = value?.isVector3 ? value.clone() : new THREE.Vector3().fromArray(value);
    if (![next.x, next.y, next.z].every(Number.isFinite)) throw new Error('部件坐标必须是三个有效数值。');
    applyPose(0);
    const unit = records.get(object);
    if (unit) {
      if (!object.matrixAutoUpdate) {
        unit.matrix.elements[12] += next.x - unit.rest.x;
        unit.matrix.elements[13] += next.y - unit.rest.y;
        unit.matrix.elements[14] += next.z - unit.rest.z;
      }
      unit.rest.copy(next);
    }
    object.position.copy(next);
    if (unit && !object.matrixAutoUpdate) object.matrix.copy(unit.matrix);
    else object.updateMatrix();
    object.matrixWorldNeedsUpdate = true;
    revision++;
    if (units.length > 1) measure();
    applyPose(restDepth ? 0 : undefined);
  }

  async function withRestPose(callback) {
    if (!restDepth) {
      restSnapshot = {
        revision,
        units: units.map(({ object }) => ({ object, position: object.position.clone(), matrix: object.matrix.clone() })),
      };
      applyPose(0);
    }
    restDepth++;
    try {
      return await callback();
    } finally {
      restDepth--;
      if (!restDepth) {
        if (!disposed && restSnapshot.revision === revision) {
          for (const { object, position, matrix } of restSnapshot.units) {
            object.position.copy(position);
            object.matrix.copy(matrix);
            object.matrixWorldNeedsUpdate = true;
          }
          root.updateWorldMatrix(true, true);
        } else applyPose(disposed ? 0 : undefined);
        restSnapshot = null;
      }
    }
  }

  return {
    get supported() { return supported && !disposed; },
    get canExplode() { return supported && !disposed; },
    get expanded() { return target === 1; },
    get moving() { return !disposed && progress !== target; },
    setExpanded(value) {
      target = supported && !disposed && value ? 1 : 0;
      return target === 1;
    },
    update(deltaSeconds) {
      if (disposed || restDepth || progress === target || !Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return false;
      const step = deltaSeconds / seconds;
      progress = target > progress ? Math.min(target, progress + step) : Math.max(target, progress - step);
      applyPose();
      return true;
    },
    getRestPosition(object) { return (records.get(object)?.rest || object.position).clone(); },
    updateRestPosition,
    setRestPosition: updateRestPosition,
    withRestPose,
    dispose() {
      target = progress = 0;
      applyPose(0);
      disposed = true;
    },
  };
}
