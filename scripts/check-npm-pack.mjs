// Prepare registry-ready manifests with pnpm (rewrites workspace:*), then let npm inspect tarballs.
// No registry writes. The @quorum npm scope is not owned by this project.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(join(tmpdir(), 'quorum-npm-pack-'));
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' });
try {
  for (const name of ['cli', 'tui']) {
    run('corepack', ['pnpm', '--filter', `@quorum/${name}`, 'pack', '--pack-destination', temp], root);
    const tarball = readdirSync(temp).find((file) => file.startsWith(`quorum-${name}-`) && file.endsWith('.tgz'));
    if (!tarball) throw new Error(`No tarball for @quorum/${name}`);
    const [result] = JSON.parse(run('npm', ['pack', '--dry-run', '--ignore-scripts', '--json', join(temp, tarball)], temp));
    const manifest = JSON.parse(run('tar', ['-xOf', join(temp, tarball), 'package/package.json'], temp));
    const bin = name === 'cli' ? 'quorum' : 'quorum-tui';
    if (!manifest.bin?.[bin] || manifest.private) throw new Error(`${name}: invalid bin or private manifest`);
    if (Object.values(manifest.dependencies ?? {}).some((value) => value.startsWith('workspace:'))) throw new Error(`${name}: unresolved workspace dependency`);
    if (JSON.stringify(manifest.exports).includes('development')) throw new Error(`${name}: source-only exports in published manifest`);
    const files = result.files.map((file) => file.path);
    for (const required of ['package.json', 'dist/cli.js', 'dist/index.js', 'README.md']) {
      if (!files.includes(required)) throw new Error(`${name}: missing ${required}`);
    }
    if (files.some((file) => /^(src|test|node_modules)\//.test(file))) throw new Error(`${name}: unexpected source/dependency files`);
    console.log(`[npm pack --dry-run] ${result.id}: ${files.length} files, ${result.size} bytes; bin and runtime files present`);
  }
} finally { rmSync(temp, { recursive: true, force: true }); }
