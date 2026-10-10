import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { createExplodedView } from './exploded-view.js';
import { createPreviewMaterials } from './preview-materials.js';

function onePixelPng(rgba) {
  function chunk(type, bytes) {
    const contents = Buffer.concat([Buffer.from(type), bytes]);
    let crc = 0xffffffff;
    for (const byte of contents) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, contents, checksum]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, ...rgba]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Only the browser byte/image adapters are supplied here. The real exporter
// performs scene traversal, material/texture serialization and GLB packing.
function installBrowserAdapters() {
  class FileReader {
    readAsArrayBuffer(blob) {
      blob.arrayBuffer().then(result => { this.result = result; this.onloadend?.(); });
    }
  }
  class ImageData {
    constructor(data, width, height) { Object.assign(this, { data, width, height }); }
  }
  class OffscreenCanvas {
    constructor(width, height) { Object.assign(this, { width, height }); }
    getContext(type) {
      assert.equal(type, '2d');
      return { putImageData: (image, x, y) => {
        assert.deepEqual([image.width, image.height, x, y], [1, 1, 0, 0]);
        this.pixel = Array.from(image.data);
      } };
    }
    async convertToBlob({ type }) {
      assert.deepEqual([this.width, this.height, type], [1, 1, 'image/png']);
      assert.equal(this.pixel.length, 4);
      return new Blob([onePixelPng(this.pixel)], { type });
    }
  }
  const adapters = { FileReader, ImageData, OffscreenCanvas };
  const descriptors = new Map(Object.keys(adapters).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(adapters)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  return () => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  };
}

test('real GLB export preserves textured source materials and assembled transforms during white exploded preview', async () => {
  const restoreBrowserAdapters = installBrowserAdapters();
  const root = new THREE.Group(), attachment = new THREE.Group();
  attachment.name = 'Attachment';
  attachment.position.set(.25, 3, -.5);
  const pixel = [210, 83, 36, 255];
  const texture = new THREE.DataTexture(new Uint8Array(pixel), 1, 1, THREE.RGBAFormat);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.name = 'Source texture';
  texture.needsUpdate = true;
  const sourceMaterial = new THREE.MeshStandardMaterial({ name: 'Source lacquer', color: '#c72341', map: texture, roughness: .37 });
  const detail = new THREE.Mesh(new THREE.BoxGeometry(), sourceMaterial);
  detail.name = 'Textured attachment';
  attachment.add(detail);
  root.add(new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), new THREE.MeshStandardMaterial()), attachment);
  const motion = createExplodedView(root), preview = createPreviewMaterials(root);
  try {
    preview.setClay(true);
    preview.setWireframe(true);
    motion.setExpanded(true);
    motion.update(1);
    const displayPosition = attachment.position.toArray();
    const whiteMaterial = detail.material;
    assert.notDeepEqual(displayPosition, [.25, 3, -.5]);
    assert.equal(whiteMaterial.map, null);
    assert.equal(whiteMaterial.wireframe, true);

    const buffer = await motion.withRestPose(() => preview.withOriginalMaterials(() =>
      new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: true, trs: true })
    ));
    const bytes = Buffer.from(buffer);
    assert.equal(bytes.toString('ascii', 0, 4), 'glTF');
    assert.equal(bytes.readUInt32LE(4), 2);
    assert.equal(bytes.readUInt32LE(8), bytes.length);
    assert.equal(bytes.toString('ascii', 16, 20), 'JSON');
    const jsonLength = bytes.readUInt32LE(12);
    const json = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength));
    const node = json.nodes.find(item => item.name === 'Attachment');
    assert.deepEqual(node.translation, [.25, 3, -.5]);
    const material = json.materials.find(item => item.name === 'Source lacquer');
    assert.deepEqual(material.pbrMetallicRoughness.baseColorFactor, [...sourceMaterial.color.toArray(), 1]);
    assert.equal(material.pbrMetallicRoughness.roughnessFactor, .37);
    const textureDef = json.textures[material.pbrMetallicRoughness.baseColorTexture.index];
    assert.equal(textureDef.name, 'Source texture');
    const image = json.images[textureDef.source];
    assert.equal(image.mimeType, 'image/png');
    const imageView = json.bufferViews[image.bufferView];
    const binaryHeader = 20 + jsonLength;
    assert.equal(bytes.readUInt32LE(binaryHeader + 4), 0x004e4942);
    const imageStart = binaryHeader + 8 + (imageView.byteOffset || 0);
    const expectedPng = onePixelPng(pixel);
    assert.ok(imageView.byteLength >= expectedPng.length);
    assert.deepEqual(bytes.subarray(imageStart, imageStart + expectedPng.length), expectedPng);
    const exportedDetail = json.nodes.find(item => item.name === detail.name);
    assert.equal(json.meshes[exportedDetail.mesh].primitives[0].mode ?? 4, 4);

    assert.deepEqual(attachment.position.toArray(), displayPosition);
    assert.equal(motion.expanded, true);
    assert.equal(preview.clay, true);
    assert.strictEqual(detail.material, whiteMaterial);
    assert.equal(detail.material.map, null);
    assert.equal(detail.material.wireframe, true);
    assert.strictEqual(sourceMaterial.map, texture);
  } finally {
    motion.dispose();
    preview.dispose();
    root.traverse(object => { object.geometry?.dispose(); object.material?.dispose(); });
    texture.dispose();
    restoreBrowserAdapters();
  }
});
