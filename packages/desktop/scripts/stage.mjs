// Produces packages/desktop/stage: an isolated copy of the app with real (not symlinked) production
// dependencies, and native modules rebuilt for Electron's ABI. The workspace's Node build is untouched,
// so `pnpm -r test` keeps using better-sqlite3 compiled for Node.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stage = join(desktop, 'stage');
const require = createRequire(join(desktop, 'package.json'));
const electronVersion = JSON.parse(readFileSync(require.resolve('electron/package.json'), 'utf8')).version;

for (const dir of ['dist/main', 'dist/preload', 'dist/renderer']) {
  if (!existsSync(join(desktop, dir))) throw new Error(`${dir} is missing — run "pnpm --filter @quorum/desktop build" first`);
}

rmSync(stage, { recursive: true, force: true });
const pnpm = process.env.npm_execpath?.includes('pnpm') ? [process.execPath, process.env.npm_execpath] : ['pnpm'];
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
console.log(`[stage] deploying @quorum/desktop → ${stage}`);
// Copy (never hard-link) files: rebuilding a hard-linked native module would rewrite the shared pnpm
// store copy and break the workspace's Node build.
run(pnpm[0], [...pnpm.slice(1), '--filter', '@quorum/desktop', 'deploy', '--prod', '--legacy', '--config.package-import-method=copy', stage], desktop);

// Belt and braces: deep-copy every native package directory so its files get fresh inodes.
const virtualStore = join(stage, 'node_modules', '.pnpm');
for (const entry of readdirSync(virtualStore)) {
  if (!entry.startsWith('better-sqlite3@')) continue;
  const pkg = join(virtualStore, entry, 'node_modules', 'better-sqlite3');
  const tmp = `${pkg}.copy`;
  cpSync(pkg, tmp, { recursive: true, dereference: true });
  rmSync(pkg, { recursive: true, force: true });
  renameSync(tmp, pkg);
}

console.log(`[stage] rebuilding native modules for Electron ${electronVersion}`);
// Rebuild exactly the staged copies. (@electron/rebuild resolves modules by walking up the directory
// tree, which from inside the repo reaches — and rewrites — the workspace's own copy.)
const nodeGyp = createRequire(require.resolve('@electron/rebuild')).resolve('node-gyp/bin/node-gyp.js');
for (const entry of readdirSync(virtualStore)) {
  if (!entry.startsWith('better-sqlite3@')) continue;
  const pkg = join(virtualStore, entry, 'node_modules', 'better-sqlite3');
  const prebuild = readdirSync(virtualStore).find((e) => e.startsWith('prebuild-install@'));
  const target = ['--runtime=electron', `--target=${electronVersion}`, `--arch=${process.arch}`];
  let ok = false;
  if (prebuild !== undefined) {
    try {
      run(process.execPath, [join(virtualStore, prebuild, 'node_modules', 'prebuild-install', 'bin.js'), ...target, '--force'], pkg);
      ok = true;
    } catch {
      console.log('[stage] no prebuilt binary for this Electron; compiling from source');
    }
  }
  if (!ok) run(process.execPath, [nodeGyp, 'rebuild', '--release', ...target, '--dist-url=https://electronjs.org/headers'], pkg);
}

// Verify the workspace's own copy still loads in plain Node.
const workspaceRequire = createRequire(join(desktop, '..', 'leader', 'package.json'));
try {
  const Database = workspaceRequire('better-sqlite3');
  new Database(':memory:').close();
} catch (error) {
  throw new Error(
    `staging changed the workspace's better-sqlite3 build (${error.message.split('\n')[0]}). ` +
      'Restore it with: (cd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 && npx prebuild-install -r node --force)',
  );
}
console.log('[stage] done');
