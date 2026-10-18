// Regenerates the app icons in build/ from build/icon.svg and build/icon-small.svg.
// Run from packages/desktop: npx electron scripts/icons.mjs   (macOS: also writes icon.icns with iconutil)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';

const build = join(import.meta.dirname, '..', 'build');
const svg = (name) => readFileSync(join(build, name), 'utf8');
const SMALL_MAX = 32; // at and below this size the check is dropped (icon-small.svg)

/** Renders `markup` on a transparent 1024×1024 page (fresh hidden window each time) and returns a 1024 px NativeImage. */
async function render(markup, inset) {
  const box = 1024 - inset * 2;
  const html = `<html><body style="margin:0;background:transparent"><div style="width:1024px;height:1024px;padding:${inset}px;box-sizing:border-box">${markup.replace('<svg ', `<svg width="${box}" height="${box}" `)}</div></body></html>`;
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, useContentSize: true });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const img = await win.webContents.capturePage();
    // capturePage returns device pixels (2048 px on a Retina display); normalise.
    return img.resize({ width: 1024, height: 1024, quality: 'best' });
  } finally {
    win.destroy();
  }
}

/** An .ico whose entries are PNGs (supported since Windows Vista). */
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ size, data }, i) => {
    const e = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, e);
    dir.writeUInt8(size >= 256 ? 0 : size, e + 1);
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)]);
}

app.dock?.hide();
// Keep running while the per-render windows open and close.
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const full = await render(svg('icon.svg'), 0);
  const fullSmall = await render(svg('icon-small.svg'), 0);
  // macOS icons follow Apple's grid: the shape fills 824 of 1024 px, centred.
  const mac = await render(svg('icon.svg'), 100);
  const macSmall = await render(svg('icon-small.svg'), 100);
  const at = (big, small, size) => (size <= SMALL_MAX ? small : big).resize({ width: size, height: size, quality: 'best' }).toPNG();

  // Linux: build/icons/<N>x<N>.png
  const icons = join(build, 'icons');
  rmSync(icons, { recursive: true, force: true });
  mkdirSync(icons);
  for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) writeFileSync(join(icons, `${size}x${size}.png`), at(full, fullSmall, size));

  // Windows: build/icon.ico
  writeFileSync(join(build, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: at(full, fullSmall, size) }))));

  // macOS: build/icon.icns via iconutil
  if (process.platform === 'darwin') {
    const set = join(build, 'icon.iconset');
    rmSync(set, { recursive: true, force: true });
    mkdirSync(set);
    for (const size of [16, 32, 128, 256, 512]) {
      writeFileSync(join(set, `icon_${size}x${size}.png`), at(mac, macSmall, size));
      writeFileSync(join(set, `icon_${size}x${size}@2x.png`), at(mac, macSmall, size * 2));
    }
    execFileSync('iconutil', ['-c', 'icns', set, '-o', join(build, 'icon.icns')]);
    rmSync(set, { recursive: true, force: true });
  } else {
    console.warn('icon.icns is only generated on macOS (iconutil); keeping the existing file');
  }
  console.log('icons written to', build);
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
