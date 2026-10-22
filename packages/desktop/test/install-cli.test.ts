import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cliInstallPlan, installCli, type InstallOptions, type RunFile } from '../src/main/install-cli.js';

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) {
    // Undo permission changes so the directory can be removed.
    try { execFileSync('chmod', ['-R', 'u+rwX', dir]); } catch { /* Windows */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
function setup(): InstallOptions {
  const directory = mkdtempSync(join(tmpdir(), 'quorum install '));
  directories.push(directory);
  const source = join(directory, 'mounted AppImage', 'cli');
  mkdirSync(join(source, 'bin'), { recursive: true });
  writeFileSync(join(source, 'node'), 'runtime');
  writeFileSync(join(source, 'node.exe'), 'runtime');
  for (const name of ['quorum', 'quorum-tui']) writeFileSync(join(source, 'bin', name), '#!/bin/sh\necho bundled-command\n', { mode: 0o755 });
  return { source, home: join(directory, 'home'), dataDir: join(directory, 'user data'), version: '0.1.5', platform: 'linux', shell: '/bin/bash', path: '/usr/bin' };
}
/** Files next to the payload, so leftovers of a staging folder or an old version show up. */
const siblings = (payload: string) => readdirSync(dirname(payload)).sort();
const asWindows = (path: string) => path.replaceAll('/', '\\');
const asRoot = process.platform !== 'win32' && process.getuid?.() === 0;

/** Fakes PowerShell: records the script and returns what where.exe prints in a fresh environment. */
function powershell(whereOutput: string) {
  const calls: { file: string; script: string; bin: string | undefined }[] = [];
  const run: RunFile = async (file, args, env) => {
    calls.push({ file, script: Buffer.from(args.at(-1)!, 'base64').toString('utf16le'), bin: env.QUORUM_CLI_BIN });
    return whereOutput;
  };
  return { calls, run };
}

describe('command-line installation', () => {
  it.skipIf(process.platform === 'win32')('survives AppImage unmount, paths with spaces and repeated installation', async () => {
    const options = setup();
    const plan = cliInstallPlan(options);
    await installCli(options);
    writeFileSync(join(options.source, 'bin', 'quorum'), '#!/bin/sh\necho updated-command\n', { mode: 0o755 });
    await installCli(options);
    rmSync(options.source, { recursive: true });
    for (const name of ['quorum', 'quorum-tui']) {
      const launcher = join(plan.bin, name);
      expect(readlinkSync(launcher)).toBe(join(plan.payload, 'bin', name));
    }
    expect(execFileSync(join(plan.bin, 'quorum'), { encoding: 'utf8' })).toBe('updated-command\n');
    expect(execFileSync(join(plan.bin, 'quorum-tui'), { encoding: 'utf8' })).toBe('bundled-command\n');
    expect(siblings(plan.payload)).toEqual(['0.1.5']);
    expect(readFileSync(plan.profile!, 'utf8').match(/# Quorum command-line tools/g)).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')('refuses existing commands or unrelated dangling symlinks', async () => {
    const options = setup();
    const { bin } = cliInstallPlan(options);
    mkdirSync(bin, { recursive: true });
    const command = join(bin, 'quorum');
    writeFileSync(command, 'another tool');
    await expect(installCli(options)).rejects.toThrow('Will not replace');
    expect(readFileSync(command, 'utf8')).toBe('another tool');
    rmSync(command);
    symlinkSync('/missing/unrelated', command);
    await expect(installCli(options)).rejects.toThrow('Will not replace');
    expect(readlinkSync(command)).toBe('/missing/unrelated');
  });

  it.skipIf(process.platform === 'win32' || asRoot)('keeps the installed version intact when the copy fails', async () => {
    const options = setup();
    const plan = cliInstallPlan(options);
    await installCli(options);
    writeFileSync(join(options.source, 'bin', 'quorum'), '#!/bin/sh\necho half-copied\n', { mode: 0o755 });
    writeFileSync(join(options.source, 'unreadable'), 'secret', { mode: 0o000 });
    await expect(installCli(options)).rejects.toThrow(/EACCES/);
    expect(execFileSync(join(plan.bin, 'quorum'), { encoding: 'utf8' })).toBe('bundled-command\n');
    expect(siblings(plan.payload)).toEqual(['0.1.5']);
  });

  it('puts the private bin first in the user PATH on Windows and confirms which quorum wins', async () => {
    const options = { ...setup(), platform: 'win32' as const };
    const { bin, payload } = cliInstallPlan(options);
    const ours = powershell(`${asWindows(bin)}\\quorum\r\n${asWindows(bin)}\\quorum.cmd\r\n`);
    await expect(installCli(options, ours.run)).resolves.toBe(`Installed quorum and quorum-tui in ${bin}. Open a new terminal, then run quorum --version or quorum tui --help.`);
    expect(ours.calls).toHaveLength(1);
    expect(ours.calls[0]).toMatchObject({ file: 'powershell.exe', bin });
    // Prepends, removes duplicates, and resolves in a new environment instead of the app's PATH.
    expect(ours.calls[0]!.script).toContain(`$new = (@($bin) + $rest) -join ';'`);
    expect(ours.calls[0]!.script).toContain(`GetEnvironmentVariable('Path', 'Machine')`);
    expect(ours.calls[0]!.script).toContain(`& where.exe '$PATH:quorum'`);
    expect(readFileSync(join(payload, 'node.exe'), 'utf8')).toBe('runtime');

    const other = 'C:\\Program Files\\nodejs\\quorum.cmd';
    const shadowed = await installCli(options, powershell(`${other}\r\n${asWindows(bin)}\\quorum.cmd\r\n`).run);
    expect(shadowed).toContain(`a new terminal runs a different quorum: ${other}`);
    expect(shadowed).not.toContain('Installed');

    expect(await installCli(options, powershell('').run)).toContain('a new terminal cannot find quorum');
    expect(siblings(payload)).toEqual(['current']);
  });

  it.skipIf(process.platform === 'win32' || asRoot)('fails clearly on Windows when node.exe in the target is locked', async () => {
    const options = { ...setup(), platform: 'win32' as const };
    const { payload } = cliInstallPlan(options);
    await installCli(options, powershell('').run);
    // A read-only file fails to open for writing, as a running node.exe does on Windows.
    chmodSync(join(payload, 'node.exe'), 0o444);
    const fake = powershell('');
    await expect(installCli(options, fake.run)).rejects.toThrow(`Cannot update ${payload}: node.exe or another file in it is in use.`);
    expect(fake.calls).toHaveLength(0);
    expect(siblings(payload)).toEqual(['current']);
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

describe('Node license for the bundled runtime', () => {
  const desktop = join(import.meta.dirname, '..');
  it('is vendored for the staged version and copied, not downloaded, at build time', () => {
    expect(readFileSync(join(desktop, 'vendor', 'node-LICENSE'), 'utf8')).toMatch(/^Node\.js is licensed for use as follows:/);
    expect(readFileSync(join(desktop, 'vendor', 'node-LICENSE.version'), 'utf8').trim()).toMatch(/^22\.\d+\.\d+$/);
    const stage = readFileSync(join(desktop, 'scripts', 'stage-cli.mjs'), 'utf8');
    expect(stage).toContain(`copyFileSync(join(desktop, 'vendor', 'node-LICENSE'), join(destination, 'NODE-LICENSE'))`);
    expect(stage).not.toMatch(/fetch\(|https:\/\//);
  });
});
