// Summarize editable material base colors, not the final textured appearance.
// Traversal matches the meshes affected by the viewport's color edit command.
export function summarizeMaterialColor(object) {
  const stack = object ? [object] : [];
  let color = null;
  while (stack.length) {
    const node = stack.pop();
    if (node.isMesh) {
      const materials = Array.isArray(node.material) ? node.material : [node.material];
      for (const material of materials) {
        if (typeof material?.color?.getHexString !== 'function') continue;
        const next = `#${material.color.getHexString()}`;
        if (color !== null && color !== next) return { color: null, colorState: 'mixed' };
        color = next;
      }
    }
    for (const child of node.children || []) stack.push(child);
  }
  return { color, colorState: color === null ? 'unavailable' : 'uniform' };
}
