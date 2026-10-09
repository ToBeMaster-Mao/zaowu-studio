import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'studio-skill', 'model-studio');
const destination = path.join(root, 'public-downloads', 'model-studio-skill.zip');
const entries = [];
async function walk(directory, relative = 'model-studio') {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const file = path.join(directory, entry.name);
    const name = `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Skill packages cannot contain symbolic links: ${name}`);
    if (entry.isDirectory()) await walk(file, name);
    else if (entry.isFile() && /\.(?:md|yaml|yml|json|txt)$/i.test(entry.name)) entries.push({ name, content: await readFile(file) });
  }
}
await walk(source);
if (!entries.some(entry => entry.name === 'model-studio/SKILL.md')) throw new Error('Missing model-studio/SKILL.md.');

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// A deterministic ZIP with standard DEFLATE; no platform archive utility is required.
const chunks = [], directory = [];
let offset = 0;
for (const entry of entries) {
  const name = Buffer.from(entry.name, 'utf8');
  const compressed = deflateRawSync(entry.content, { level: 9 });
  const crc = crc32(entry.content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(33, 12); // 1980-01-01, stable across machines
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(entry.content.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(33, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(entry.content.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42);
  chunks.push(local, name, compressed);
  directory.push(central, name);
  offset += local.length + name.length + compressed.length;
}
const centralSize = directory.reduce((sum, buffer) => sum + buffer.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(entries.length, 8);
end.writeUInt16LE(entries.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);
await mkdir(path.dirname(destination), { recursive: true });
await writeFile(destination, Buffer.concat([...chunks, ...directory, end]));
console.log(`Packed ${entries.length} skill files → public-downloads/model-studio-skill.zip`);
