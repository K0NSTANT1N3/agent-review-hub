// Builds installers from the staged app: AppImage + deb (Linux), dmg (macOS), NSIS (Windows).
// Usage: node scripts/package.mjs [--linux|--mac|--win] (defaults to the current platform).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(desktop, 'package.json'));
const electronVersion = JSON.parse(readFileSync(require.resolve('electron/package.json'), 'utf8')).version;
const { build, Platform } = require('electron-builder');

const flag = process.argv[2];
const platform =
  flag === '--linux' ? Platform.LINUX : flag === '--mac' ? Platform.MAC : flag === '--win' ? Platform.WINDOWS : Platform.current();

await build({
  projectDir: join(desktop, 'stage'),
  targets: platform.createTarget(),
  config: {
    extends: join(desktop, 'electron-builder.yml'),
    electronVersion,
    directories: { output: join(desktop, 'release'), buildResources: join(desktop, 'build') },
  },
  publish: 'never',
});
console.log(`[package] installers written to ${join(desktop, 'release')}`);
