// Runs the actual launchers from the packaged resources, never from the workspace.
// Optional argument: resources directory of an app copied out of a mounted installer.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = join(desktop, 'release');
const macDirectory = join(release, `mac${process.arch === 'arm64' ? '-arm64' : ''}`);
const packaged = process.platform === 'darwin'
  ? join(macDirectory, readdirSync(macDirectory).find((name) => name.endsWith('.app')) ?? 'quorum.app', 'Contents', 'Resources')
  : join(release, process.platform === 'win32' ? 'win-unpacked' : 'linux-unpacked', 'resources');
const resources = resolve(process.argv[2] ?? packaged);
const payload = join(resources, 'cli');
if (!existsSync(payload)) throw new Error(`Missing bundled CLI: ${payload}`);
const temporary = mkdtempSync(join(tmpdir(), 'quorum-packaged-cli-'));
try {
  const env = { ...process.env, QUORUM_CONFIG: join(temporary, 'no-login.json'), QUORUM_URL: '', QUORUM_TOKEN: '' };
  // Remove workspace Node and package-manager bins. Launchers must use the bundled runtime.
  env.PATH = process.platform === 'win32' ? `${process.env.SystemRoot}\\System32` : '/usr/bin:/bin';
  for (const [command, args, expected] of [
    ['quorum', ['--version'], /^quorum \d+\.\d+\.\d+/],
    ['quorum', ['tui', '--help'], /Usage:\s+quorum tui/],
    ['quorum-tui', ['--help'], /quorum-tui \[--url/],
  ]) {
    const launcher = join(payload, 'bin', `${command}${process.platform === 'win32' ? '.cmd' : ''}`);
    const output = process.platform === 'win32'
      ? execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${launcher}" ${args.join(' ')}"`], { cwd: temporary, env, encoding: 'utf8', windowsVerbatimArguments: true })
      : execFileSync(launcher, args, { cwd: temporary, env, encoding: 'utf8' });
    if (!expected.test(output)) throw new Error(`Unexpected output from ${command}: ${output}`);
    console.log(`$ ${command} ${args.join(' ')}\n${output.trim()}\n[exit 0]`);
  }
  // Detect accidental omission of the TUI module even though quorum tui --help is intentionally lazy.
  const node = join(payload, process.platform === 'win32' ? 'node.exe' : 'node');
  execFileSync(node, ['--input-type=module', '-e', "await import('@quorum/tui/start'); console.log('TUI module loads')"], {
    cwd: join(payload, 'app'), env, stdio: 'inherit',
  });
  console.log(`[smoke-cli] passed: ${resources}; payload entries: ${readdirSync(payload).join(', ')}`);
} finally { rmSync(temporary, { recursive: true, force: true }); }
