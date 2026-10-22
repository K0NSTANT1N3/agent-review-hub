import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cliInstallPlan, installCli, type InstallOptions } from '../src/main/install-cli.js';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup(): InstallOptions {
  const directory = mkdtempSync(join(tmpdir(), 'quorum install '));
  directories.push(directory);
  const source = join(directory, 'mounted AppImage', 'cli');
  mkdirSync(join(source, 'bin'), { recursive: true });
  writeFileSync(join(source, 'node'), 'runtime');
  for (const name of ['quorum', 'quorum-tui']) writeFileSync(join(source, 'bin', name), '#!/bin/sh\necho bundled-command\n', { mode: 0o755 });
  return { source, home: join(directory, 'home'), dataDir: join(directory, 'user data'), version: '0.1.5', platform: 'linux', shell: '/bin/bash', path: '/usr/bin' };
}

describe('command-line installation', () => {
  it.skipIf(process.platform === 'win32')('survives AppImage unmount, paths with spaces and repeated installation', () => {
    const options = setup();
    const plan = cliInstallPlan(options);
    installCli(options);
    installCli(options);
    rmSync(options.source, { recursive: true });
    for (const name of ['quorum', 'quorum-tui']) {
      const launcher = join(plan.bin, name);
      expect(readlinkSync(launcher)).toBe(join(plan.payload, 'bin', name));
      expect(execFileSync(launcher, { encoding: 'utf8' })).toBe('bundled-command\n');
    }
    expect(readFileSync(plan.profile!, 'utf8').match(/# Quorum command-line tools/g)).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')('refuses existing commands or unrelated dangling symlinks', () => {
    const options = setup();
    const { bin } = cliInstallPlan(options);
    mkdirSync(bin, { recursive: true });
    const command = join(bin, 'quorum');
    writeFileSync(command, 'another tool');
    expect(() => installCli(options)).toThrow('Will not replace');
    expect(readFileSync(command, 'utf8')).toBe('another tool');
    rmSync(command);
    symlinkSync('/missing/unrelated', command);
    expect(() => installCli(options)).toThrow('Will not replace');
    expect(readlinkSync(command)).toBe('/missing/unrelated');
  });

  it('plans user PATH for Windows, shell config for macOS/fish, and no edits when already on PATH', () => {
    const options = setup();
    expect(cliInstallPlan({ ...options, platform: 'win32' })).toMatchObject({ bin: join(options.dataDir, 'command-line', 'current', 'bin'), profile: null });
    expect(cliInstallPlan({ ...options, platform: 'darwin', shell: '/bin/zsh' }).profile).toBe(join(options.home, '.zshrc'));
    expect(cliInstallPlan({ ...options, shell: '/usr/bin/fish' }).profile).toBe(join(options.home, '.config/fish/conf.d/quorum.fish'));
    expect(cliInstallPlan({ ...options, path: join(options.home, '.local', 'bin') }).profile).toBeNull();
    expect(existsSync(options.home)).toBe(false);
  });
});
