import { spawn } from 'node:child_process';
import { root, sourceFiles } from './source-files.mjs';

const files = (await sourceFiles()).filter(file => /\.test\.mjs$/.test(file));
if (!files.length) throw new Error('No unit tests found.');
// Unit tests must not connect to a user's live Codex session through inherited settings.
const environment = { ...process.env };
delete environment.STUDIO_TEST_ORIGIN;
const child = spawn(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit', env: environment, windowsHide: true });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
