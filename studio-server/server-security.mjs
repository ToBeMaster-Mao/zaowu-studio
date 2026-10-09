import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';

const fail = message => Object.assign(new Error(message), { status: 403 });
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

/** Decode URL paths before calling this helper; Windows backslashes are never URL separators. */
export async function resolvePublicFile(base, pathname) {
  const routeRoot = ['/studio-web/', '/studio-viewer/', '/node_modules/three/'].find(prefix => pathname.startsWith(prefix));
  if (!routeRoot || /[\\\u0000:]/.test(pathname) || pathname.split('/').includes('..')) throw fail('公开资源路径无效。');
  const directory = path.resolve(base, `.${routeRoot}`);
  const file = path.resolve(directory, pathname.slice(routeRoot.length));
  if (!inside(directory, file)) throw fail('公开资源路径无效。');
  const [actualDirectory, actualFile] = await Promise.all([realpath(directory), realpath(file)]);
  if (!inside(actualDirectory, actualFile)) throw fail('公开资源不能指向目录外的文件。');
  return actualFile;
}

export function tokenMatches(value, expected) {
  if (typeof value !== 'string' || typeof expected !== 'string') return false;
  const supplied = Buffer.from(value), wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

/** Hold ownership across awaited I/O so a task cannot start halfway through an edit. */
export class MutationGate {
  busy = false;
  async run(operation) {
    if (this.busy) throw Object.assign(new Error('项目正在保存，请稍后重试。'), { status: 409 });
    this.busy = true;
    try { return await operation(); }
    finally { this.busy = false; }
  }
}
