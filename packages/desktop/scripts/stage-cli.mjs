// A separate, pure-Node payload: never rebuild these dependencies for Electron.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = join(desktop, 'cli-stage');
if (Number(process.versions.node.split('.')[0]) !== 22) throw new Error('Stage the CLI with Node 22.');
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
const pnpm = process.env.npm_execpath?.includes('pnpm') ? [process.execPath, process.env.npm_execpath] : ['pnpm'];
execFileSync(pnpm[0], [...pnpm.slice(1), '--filter', '@quorum/cli', 'deploy', '--prod', '--legacy', '--config.package-import-method=copy', '--config.node-linker=hoisted', join(destination, 'app')], {
  cwd: desktop, stdio: 'inherit', shell: process.platform === 'win32',
});
copyFileSync(process.execPath, join(destination, process.platform === 'win32' ? 'node.exe' : 'node'));
// Include Node's license, including its third-party notices, with the redistributed runtime.
// Vendored so offline builds work; vendor/README.md says how to refresh it.
copyFileSync(join(desktop, 'vendor', 'node-LICENSE'), join(destination, 'NODE-LICENSE'));
const licensed = readFileSync(join(desktop, 'vendor', 'node-LICENSE.version'), 'utf8').trim();
if (licensed !== process.versions.node) {
  console.warn(`[stage-cli] vendor/node-LICENSE is for Node ${licensed}, but this build bundles Node ${process.versions.node}. Refresh it: see vendor/README.md.`);
}
mkdirSync(join(destination, 'bin'));
for (const name of ['quorum', 'quorum-tui']) {
  const entry = name === 'quorum-tui' ? 'app/node_modules/@quorum/tui/dist/cli.js' : 'app/dist/cli.js';
  // Follow the installed symlink before resolving the payload. Handles spaces and relative links.
  writeFileSync(join(destination, 'bin', name), `#!/bin/sh
set -eu
target=$0
while [ -L "$target" ]; do
  base=$(CDPATH= cd -P -- "$(dirname -- "$target")" && pwd)
  target=$(readlink "$target")
  case "$target" in /*) ;; *) target=$base/$target ;; esac
done
base=$(CDPATH= cd -P -- "$(dirname -- "$target")/.." && pwd)
exec "$base/node" "$base/${entry}" "$@"
`);
  chmodSync(join(destination, 'bin', name), 0o755);
  writeFileSync(join(destination, 'bin', `${name}.cmd`), `@echo off\r\n"%~dp0..\\node.exe" "%~dp0..\\${entry.replaceAll('/', '\\')}" %*\r\n`);
}
if (process.platform !== 'win32') chmodSync(join(destination, 'node'), 0o755);
const version = JSON.parse(readFileSync(join(destination, 'app/package.json'), 'utf8')).version;
console.log(`[stage-cli] quorum ${version}, Node ${process.versions.node}, ${process.platform}/${process.arch}`);
