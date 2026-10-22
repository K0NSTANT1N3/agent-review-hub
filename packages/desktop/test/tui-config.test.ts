import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tuiConfigPath, writeTuiConfig } from '../src/main/tui-config.js';

const posix = process.platform !== 'win32';
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quorum-tui-config-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('tuiConfigPath', () => {
  it('uses QUORUM_TUI_CONFIG, then XDG_CONFIG_HOME, then ~/.config, and never the quorum CLI login', () => {
    expect(tuiConfigPath({ QUORUM_TUI_CONFIG: '/x/t.json', QUORUM_CONFIG: '/x/c.json', XDG_CONFIG_HOME: '/xdg' }, '/home/a')).toBe('/x/t.json');
    expect(tuiConfigPath({ QUORUM_CONFIG: '/x/c.json', XDG_CONFIG_HOME: '/xdg' }, '/home/a')).toBe(join('/xdg', 'quorum', 'tui.json'));
    expect(tuiConfigPath({ XDG_CONFIG_HOME: '' }, '/home/a')).toBe(join('/home/a', '.config', 'quorum', 'tui.json'));
  });
});

describe('writeTuiConfig', () => {
  it('creates a private folder and a 0600 file in the CLI JSON format', () => {
    const path = join(dir, 'new', 'quorum', 'tui.json');
    writeTuiConfig(path, { url: 'http://127.0.0.1:7420', token: 'qrq_secret' });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ url: 'http://127.0.0.1:7420', token: 'qrq_secret' });
    if (posix) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'new', 'quorum')).mode & 0o777).toBe(0o700);
    }
  });

  it('replaces a world-readable config with a 0600 file and leaves no temporary file', () => {
    const path = join(dir, 'tui.json');
    writeFileSync(path, '{"url":"http://old","token":"qrq_old"}');
    if (posix) chmodSync(path, 0o644);
    writeTuiConfig(path, { url: 'http://new', token: 'qrq_new' });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ url: 'http://new', token: 'qrq_new' });
    if (posix) expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['tui.json']);
  });
});
