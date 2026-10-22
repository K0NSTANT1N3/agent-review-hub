import { execFile } from 'node:child_process';
import { access, appendFile, cp, lstat, mkdir, open, readFile, readlink, rename, rm, symlink, unlink } from 'node:fs/promises';
import { dirname, join, resolve, win32 } from 'node:path';
import { promisify } from 'node:util';

export interface InstallOptions {
  source: string;
  dataDir: string;
  home: string;
  version: string;
  platform: NodeJS.Platform;
  shell?: string;
  path?: string;
}

/** Runs a program and resolves with its stdout. Tests replace it; Windows-only programs cannot run elsewhere. */
export type RunFile = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string>;

const execFileAsync = promisify(execFile);
const runFile: RunFile = async (file, args, env) => (await execFileAsync(file, args, { env, windowsHide: true, encoding: 'utf8' })).stdout;

/** All changes in this plan are described in the native confirmation before installation. */
export function cliInstallPlan(options: InstallOptions) {
  const windows = options.platform === 'win32';
  const payload = join(options.dataDir, 'command-line', windows ? 'current' : options.version);
  const bin = windows ? join(payload, 'bin') : join(options.home, '.local', 'bin');
  const needsPath = !(options.path ?? '').split(windows ? ';' : ':').includes(bin);
  const fish = options.shell?.endsWith('/fish');
  const profile = !windows && needsPath
    ? fish ? join(options.home, '.config/fish/conf.d/quorum.fish')
      : join(options.home, options.shell?.endsWith('/zsh') ? '.zshrc' : '.bashrc')
    : null;
  return { payload, bin, profile, needsPath, fish };
}

function hasCode(error: unknown, ...codes: string[]): boolean {
  return error instanceof Error && 'code' in error && codes.includes(String(error.code));
}

const inUse = (payload: string) =>
  new Error(`Cannot update ${payload}: node.exe or another file in it is in use. Close every quorum and quorum-tui window, then try again.`);

const installed = (bin: string) =>
  `Installed quorum and quorum-tui in ${bin}. Open a new terminal, then run quorum --version or quorum tui --help.`;

export async function installCli(options: InstallOptions, run: RunFile = runFile): Promise<string> {
  const plan = cliInstallPlan(options);
  const windows = options.platform === 'win32';
  try { await access(join(options.source, windows ? 'node.exe' : 'node')); } catch {
    throw new Error('The CLI is missing. Install a packaged Quorum app.');
  }
  // Refuse to overwrite another program, including dangling or unrelated symlinks.
  if (!windows) for (const name of ['quorum', 'quorum-tui']) {
    const link = join(plan.bin, name);
    try {
      const stat = await lstat(link);
      const target = stat.isSymbolicLink() ? resolve(dirname(link), await readlink(link)) : '';
      const owned = ['quorum', 'quorum-tui'].some((command) => target === join(plan.payload, 'bin', command))
        || target.startsWith(`${join(options.dataDir, 'command-line')}/`) && target.endsWith(`/bin/${name}`);
      if (!owned) throw new Error(`Will not replace ${link}. Move the existing command, then try again.`);
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
  }
  // A running quorum keeps node.exe open, and Windows refuses to write or move it.
  if (windows) {
    try { await (await open(join(plan.payload, 'node.exe'), 'r+')).close(); } catch (error) {
      if (hasCode(error, 'EBUSY', 'EPERM', 'EACCES')) throw inUse(plan.payload);
      if (!hasCode(error, 'ENOENT')) throw error;
    }
  }
  // AppImage mount paths disappear on exit. A private copy also survives moving the desktop app.
  await replaceDirectory(options.source, plan.payload, windows);
  await mkdir(plan.bin, { recursive: true });
  if (windows) return updateWindowsPath(plan.bin, run);
  for (const name of ['quorum', 'quorum-tui']) {
    const link = join(plan.bin, name);
    try { await unlink(link); } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
    await symlink(join(plan.payload, 'bin', name), link);
  }
  if (plan.profile) {
    const marker = '# Quorum command-line tools';
    const content = await readFile(plan.profile, 'utf8').catch((error: unknown) => {
      if (hasCode(error, 'ENOENT')) return '';
      throw error;
    });
    if (!content.includes(marker)) {
      await mkdir(dirname(plan.profile), { recursive: true });
      await appendFile(plan.profile, `\n${marker}\n${plan.fish ? 'fish_add_path "$HOME/.local/bin"' : 'export PATH="$HOME/.local/bin:$PATH"'}\n`);
    }
  }
  return installed(plan.bin);
}

/** Copy beside the target, then swap it in with renames: a failed copy never leaves a mixed tree. */
async function replaceDirectory(source: string, target: string, windows: boolean) {
  const staging = `${target}.staging`;
  const old = `${target}.old`;
  await mkdir(dirname(target), { recursive: true });
  // Leftovers of an interrupted installation.
  await rm(staging, { recursive: true, force: true });
  await rm(old, { recursive: true, force: true });
  try {
    await cp(source, staging, { recursive: true });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  let moved = false;
  try {
    await rename(target, old);
    moved = true;
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) {
      await rm(staging, { recursive: true, force: true });
      throw windows && hasCode(error, 'EBUSY', 'EPERM', 'EACCES') ? inUse(target) : error;
    }
  }
  try {
    await rename(staging, target);
  } catch (error) {
    if (moved) await rename(old, target).catch(() => undefined);
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  // Only now is the old version unused. If removal fails, the next installation removes it.
  if (moved) await rm(old, { recursive: true, force: true }).catch(() => undefined);
}

async function updateWindowsPath(bin: string, run: RunFile): Promise<string> {
  // Pass the directory as data, never as PowerShell source. Keep raw %VAR% entries intact.
  const script = `$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
$old = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$bin = $env:QUORUM_CLI_BIN
# Put the private bin first in the user PATH and drop any other copy of it.
$rest = @($old -split ';' | Where-Object { $_ -and $_.TrimEnd('\\') -ne $bin.TrimEnd('\\') })
$new = (@($bin) + $rest) -join ';'
if ($new -ne $old) { $key.SetValue('Path', $new, [Microsoft.Win32.RegistryValueKind]::ExpandString) }
$key.Close()
# Notify Explorer so newly opened terminals inherit the user PATH.
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class QuorumEnvironment { [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r); }'
$result = [UIntPtr]::Zero
[void][QuorumEnvironment]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
# Resolve quorum as a new terminal does: the system PATH, then the user PATH.
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$env:Path = (@([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User')) | Where-Object { $_ }) -join ';'
& where.exe '$PATH:quorum' 2>$null
exit 0`;
  const found = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference = 'Stop'\n${script}`, 'utf16le').toString('base64')], {
    ...process.env, QUORUM_CLI_BIN: bin,
  });
  const first = found.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  const key = (path: string) => path.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
  if (!first) {
    return `Copied quorum and quorum-tui to ${bin}, but a new terminal cannot find quorum. Make sure that ${bin} is in your user PATH.`;
  }
  if (key(win32.dirname(first)) !== key(bin)) {
    return `Copied quorum and quorum-tui to ${bin}, but a new terminal runs a different quorum: ${first}. `
      + `Remove that program, or move its folder after ${bin} in PATH. The system PATH comes before the user PATH.`;
  }
  return installed(bin);
}
