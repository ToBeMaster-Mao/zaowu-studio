import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);

// Compatibility for a server already running before the revision GET route existed.
// Project files are only read; output contains no task, conversation, path, or token.
export async function snapshotPreviewManifests({
  projectsRoot = process.env.STUDIO_DATA_DIR || path.join(base, '.studio', 'projects'),
  outputRoot = path.join(base, 'studio-web', 'revision-previews'),
} = {}) {
  projectsRoot = path.resolve(projectsRoot);
  outputRoot = path.resolve(outputRoot);
  const relativeOutput = path.relative(projectsRoot, outputRoot);
  if (!relativeOutput || (!relativeOutput.startsWith(`..${path.sep}`) && relativeOutput !== '..' && !path.isAbsolute(relativeOutput))) {
    throw new Error('Preview manifests must be written outside the project storage directory.');
  }
  const result = { written: 0, unchanged: 0, projects: 0 };
  for (const entry of await readdir(projectsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !safeId(entry.name)) continue;
    let project;
    try { project = JSON.parse(await readFile(path.join(projectsRoot, entry.name, 'project.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    result.projects++;
    for (const revision of project.versions || []) {
      if (revision.status !== 'valid' || !safeId(revision.id)) continue;
      const contents = `${JSON.stringify({ id: revision.id, overrides: revision.overrides || {} }, null, 2)}\n`;
      const directory = path.join(outputRoot, entry.name);
      const file = path.join(directory, `${revision.id}.json`);
      let existing;
      try { existing = await readFile(file, 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (existing === contents) { result.unchanged++; continue; }
      await mkdir(directory, { recursive: true });
      await writeFile(file, contents);
      result.written++;
    }
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await snapshotPreviewManifests()));
}
