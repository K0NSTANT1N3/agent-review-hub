import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cliConfigPath, writeCliConfig } from '../src/main/cli-config.js';

const posix = process.platform !== 'win32';
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quorum-cli-config-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('cliConfigPath', () => {
  it('uses QUORUM_CONFIG, then XDG_CONFIG_HOME, then ~/.config like the quorum CLI', () => {
    expect(cliConfigPath({ QUORUM_CONFIG: '/x/c.json', XDG_CONFIG_HOME: '/xdg' }, '/home/a')).toBe('/x/c.json');
    expect(cliConfigPath({ XDG_CONFIG_HOME: '/xdg' }, '/home/a')).toBe(join('/xdg', 'quorum', 'cli.json'));
    expect(cliConfigPath({ XDG_CONFIG_HOME: '' }, '/home/a')).toBe(join('/home/a', '.config', 'quorum', 'cli.json'));
  });
});

describe('writeCliConfig', () => {
  it('creates a private folder and a 0600 file in the CLI JSON format', () => {
    const path = join(dir, 'new', 'quorum', 'cli.json');
    writeCliConfig(path, { url: 'http://127.0.0.1:7420', token: 'qrq_secret' });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ url: 'http://127.0.0.1:7420', token: 'qrq_secret' });
    if (posix) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'new', 'quorum')).mode & 0o777).toBe(0o700);
    }
  });

  it('replaces a world-readable config with a 0600 file and leaves no temporary file', () => {
    const path = join(dir, 'cli.json');
    writeFileSync(path, '{"url":"http://old","token":"qrq_old"}');
    if (posix) chmodSync(path, 0o644);
    writeCliConfig(path, { url: 'http://new', token: 'qrq_new' });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ url: 'http://new', token: 'qrq_new' });
    if (posix) expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['cli.json']);
  });
});
