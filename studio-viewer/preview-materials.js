import * as THREE from 'three';

const list = material => Array.isArray(material) ? material : [material];

/** Inspection materials never replace the project's editable materials. */
export function createPreviewMaterials(root) {
  const originals = new Map();
  const initialWireframe = new Map();
  const clayMaterials = new Map();
  let clay = false, wireframe = false, suspended = 0;

  function remember(material) {
    if (material && !initialWireframe.has(material)) initialWireframe.set(material, Boolean(material.wireframe));
  }
  root.traverse(object => {
    if (!object.isMesh) return;
    originals.set(object, object.material);
    list(object.material).forEach(remember);
  });

  function whiteMaterial(original) {
    if (!clayMaterials.has(original)) {
      clayMaterials.set(original, new THREE.MeshStandardMaterial({
        color: '#f5f5f5', roughness: .8, metalness: 0,
        side: original.side, flatShading: Boolean(original.flatShading),
        polygonOffset: original.polygonOffset, polygonOffsetFactor: original.polygonOffsetFactor,
        polygonOffsetUnits: original.polygonOffsetUnits,
      }));
    }
    const material = clayMaterials.get(original);
    material.wireframe = wireframe || initialWireframe.get(original);
    return material;
  }

  function refresh() {
    for (const [material, original] of initialWireframe) {
      if ('wireframe' in material) material.wireframe = suspended ? original : wireframe || original;
    }
    for (const [object, material] of originals) {
      object.material = clay && !suspended
        ? Array.isArray(material) ? material.map(whiteMaterial) : whiteMaterial(material)
        : material;
    }
  }

  function withOriginalMaterials(callback) {
    suspended++;
    refresh();
    const finish = () => { suspended--; refresh(); };
    try {
      const result = callback();
      if (result && typeof result.then === 'function') return Promise.resolve(result).finally(finish);
      finish();
      return result;
    } catch (error) {
      finish();
      throw error;
    }
  }

  return {
    get clay() { return clay; },
    getOriginalMaterial(object) { return originals.get(object) ?? object.material; },
    getOriginalMaterials() { return [...initialWireframe.keys()]; },
    setClay(value) { clay = Boolean(value); refresh(); },
    setWireframe(value) { wireframe = Boolean(value); refresh(); },
    setColor(object, color) {
      object.traverse(child => {
        if (!child.isMesh) return;
        const original = originals.get(child) ?? child.material;
        const copies = list(original).map(material => {
          const copy = material.clone();
          if (copy.color) copy.color.set(color);
          initialWireframe.set(copy, initialWireframe.get(material) ?? Boolean(material.wireframe));
          return copy;
        });
        originals.set(child, Array.isArray(original) ? copies : copies[0]);
      });
      refresh();
    },
    withOriginalMaterials,
    dispose() {
      clay = wireframe = false;
      refresh();
      for (const material of clayMaterials.values()) material.dispose();
      clayMaterials.clear();
    },
  };
}
