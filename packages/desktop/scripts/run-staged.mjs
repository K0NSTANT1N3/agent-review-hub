// Launches the staged app with the workspace's Electron binary.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(desktop, 'package.json'));
const electron = require('electron');
const args = [join(desktop, 'stage'), ...process.argv.slice(2)];
if (process.platform === 'linux' && process.env.QUORUM_NO_SANDBOX === '1') args.push('--no-sandbox');
const child = spawn(electron, args, { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
