import { execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface InstallOptions {
  source: string;
  dataDir: string;
  home: string;
  version: string;
  platform: NodeJS.Platform;
  shell?: string;
  path?: string;
}

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

export function installCli(options: InstallOptions): string {
  const plan = cliInstallPlan(options);
  const windows = options.platform === 'win32';
  if (!existsSync(join(options.source, windows ? 'node.exe' : 'node'))) throw new Error('The CLI is missing. Install a packaged Quorum app.');
  // Refuse to overwrite another program, including dangling or unrelated symlinks.
  if (!windows) for (const name of ['quorum', 'quorum-tui']) {
    const link = join(plan.bin, name);
    try {
      const stat = lstatSync(link);
      const target = stat.isSymbolicLink() ? resolve(dirname(link), readlinkSync(link)) : '';
      const owned = ['quorum', 'quorum-tui'].some((command) => target === join(plan.payload, 'bin', command))
        || target.startsWith(`${join(options.dataDir, 'command-line')}/`) && target.endsWith(`/bin/${name}`);
      if (!owned) throw new Error(`Will not replace ${link}. Move the existing command, then try again.`);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  // AppImage mount paths disappear on exit. A private copy also survives moving the desktop app.
  mkdirSync(dirname(plan.payload), { recursive: true });
  cpSync(options.source, plan.payload, { recursive: true });
  mkdirSync(plan.bin, { recursive: true });
  if (windows) {
    // Pass the directory as data, never as PowerShell source. Keep raw %VAR% entries intact.
    const script = `$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
$old = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$bin = $env:QUORUM_CLI_BIN
if (-not (($old -split ';').TrimEnd('\\') -contains $bin.TrimEnd('\\'))) {
  $key.SetValue('Path', ($old.TrimEnd(';') + ';' + $bin).TrimStart(';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
}
$key.Close()
# Notify Explorer so newly opened terminals inherit the user PATH.
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class QuorumEnvironment { [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r); }'
$result = [UIntPtr]::Zero
[void][QuorumEnvironment]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference = 'Stop'\n${script}`, 'utf16le').toString('base64')], {
      env: { ...process.env, QUORUM_CLI_BIN: plan.bin }, windowsHide: true,
    });
  } else {
    for (const name of ['quorum', 'quorum-tui']) {
      const link = join(plan.bin, name);
      try { unlinkSync(link); } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      symlinkSync(join(plan.payload, 'bin', name), link);
    }
    if (plan.profile) {
      const marker = '# Quorum command-line tools';
      const content = existsSync(plan.profile) ? readFileSync(plan.profile, 'utf8') : '';
      if (!content.includes(marker)) {
        mkdirSync(dirname(plan.profile), { recursive: true });
        appendFileSync(plan.profile, `\n${marker}\n${plan.fish ? 'fish_add_path "$HOME/.local/bin"' : 'export PATH="$HOME/.local/bin:$PATH"'}\n`);
      }
    }
  }
  return `Installed quorum and quorum-tui in ${plan.bin}. Open a new terminal, then run quorum --version or quorum tui --help.`;
}
