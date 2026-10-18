import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNodeConfig } from '@quorum/protocol';
import { encodeJoinCode } from '@quorum/protocol/join-code';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { needsInsecure, parseJoinArgs, runJoin, startCommandFor } from '../src/join.js';

const code = (leaderUrl = 'wss://quorum.example.com/ws/node'): string =>
  encodeJoinCode({ leaderUrl, agentId: 'bo-agent', ownerName: 'Bo', token: 'qrm_secret', repoRemoteUrl: 'git@github.com:acme/app.git' });

let dir: string;
let home: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'quorum-join-'));
  home = join(dir, 'home');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('quorum-node join', () => {
  it('writes a valid owner-only config with server defaults and prints the start command', async () => {
    const lines: string[] = [];
    const result = runJoin([code()], (line) => lines.push(line), dir, home);

    const path = join(dir, 'quorum.node.json');
    expect(result.configPath).toBe(path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const config = parseNodeConfig(JSON.parse(await readFile(path, 'utf8')));
    expect(config).toMatchObject({
      leaderUrl: 'wss://quorum.example.com/ws/node',
      agentId: 'bo-agent',
      ownerName: 'Bo',
      token: 'qrm_secret',
      repoRemoteUrl: 'git@github.com:acme/app.git',
      dataDir: join(home, '.quorum', 'node'),
      workspaceDir: join(home, '.quorum', 'workspace'),
      gitIdentity: { name: 'Bo (quorum agent)', email: 'bo-agent@quorum.local' },
      adapter: { type: 'claude-code' },
      lendMode: 'always',
    });
    expect(result.startCommand).toBe(`quorum-node start --config ${path}`);
    expect(lines.at(-1)).toBe(`  ${result.startCommand}`);
    expect(lines.join('\n')).not.toContain('qrm_secret');
  });

  it('honours --config, --data-dir, adapter and lending options', async () => {
    const result = runJoin(
      [code(), '--config', 'cfg/bo.json', '--data-dir', 'state', '--adapter', 'opencode', '--opencode-url', 'http://127.0.0.1:4096',
        '--provider', 'anthropic', '--model', 'claude-sonnet', '--lend-mode', 'when_idle', '--max-sessions', '3', '--tags', 'go, sql'],
      () => {}, dir, home,
    );
    expect(result.configPath).toBe(join(dir, 'cfg', 'bo.json'));
    expect(result.config).toMatchObject({
      dataDir: join(dir, 'state', 'node'),
      adapter: { type: 'opencode', baseUrl: 'http://127.0.0.1:4096', providerID: 'anthropic', modelID: 'claude-sonnet' },
      lendMode: 'when_idle',
      maxSessions: 3,
      tags: ['go', 'sql'],
    });
    expect(result.startCommand).toContain('--assume-idle');
  });

  it('warns only for public plaintext connections', () => {
    expect(needsInsecure('ws://10.0.0.5:7420/ws/node')).toBe(false);
    expect(needsInsecure('ws://ana.tail1234.ts.net:7420/ws/node')).toBe(false);
    expect(needsInsecure('ws://100.101.102.103:7420/ws/node')).toBe(false);
    expect(needsInsecure('ws://203.0.113.7:7420/ws/node')).toBe(true);
    expect(needsInsecure('ws://127.0.0.1:7420/ws/node')).toBe(false);
    expect(needsInsecure('ws://[::1]:7420/ws/node')).toBe(false);
    expect(needsInsecure('wss://x.trycloudflare.com/ws/node')).toBe(false);
    const lines: string[] = [];
    const result = runJoin([code('ws://203.0.113.7:7420/ws/node')], (line) => lines.push(line), dir, home);
    expect(result.startCommand).toMatch(/--insecure$/);
    expect(lines.some((line) => line === 'Warning: this public connection uses unencrypted ws://; prefer a VPN or TLS tunnel.')).toBe(true);
    const privateLines: string[] = [];
    const lan = runJoin([code('ws://10.0.0.5:7420/ws/node'), '--force'], (line) => privateLines.push(line), dir, home);
    expect(lan.startCommand).not.toMatch(/--insecure$/);
    expect(privateLines.some((line) => line.startsWith('Warning:'))).toBe(false);
  });

  it('refuses to overwrite an existing config unless --force is given', async () => {
    const path = join(dir, 'quorum.node.json');
    await writeFile(path, '{}');
    expect(() => runJoin([code()], () => {}, dir, home)).toThrow(/already exists; pass --force/);
    runJoin([code(), '--force'], () => {}, dir, home);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ agentId: 'bo-agent' });
  });

  it.skipIf(process.platform === 'win32')('refuses an existing dangling config symlink without --force', async () => {
    const path = join(dir, 'quorum.node.json');
    const target = join(dir, 'other.json');
    await symlink(target, path);

    expect(() => runJoin([code()], () => {}, dir, home)).toThrow(/already exists; pass --force/);
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects bad input with a clear message', () => {
    expect(() => parseJoinArgs([], dir, home)).toThrow(/exactly one join code/);
    expect(() => parseJoinArgs(['hello'], dir, home)).toThrow(/Not a Quorum join code/);
    expect(() => parseJoinArgs([code(), '--adapter', 'gpt'], dir, home)).toThrow(/--adapter must be/);
    expect(() => parseJoinArgs([code(), '--lend-mode', 'sometimes'], dir, home)).toThrow(/--lend-mode must be/);
    expect(() => parseJoinArgs([code(), '--max-sessions', '0'], dir, home)).toThrow(/--max-sessions/);
    expect(() => runJoin([code(), '--adapter', 'opencode'], () => {}, dir, home)).toThrow(/needs --opencode-url/);
    expect(() => runJoin([code(), '--adapter', 'mock'], () => {}, dir, home)).toThrow(/needs --mock-script/);
  });

  it('quotes paths with spaces in the start command', () => {
    const config = parseNodeConfig({
      leaderUrl: 'wss://h/ws/node', agentId: 'a', token: 't', ownerName: 'A', repoRemoteUrl: 'r',
      gitIdentity: { name: 'A', email: 'a@x' }, adapter: { type: 'claude-code' }, lendMode: 'always',
    });
    expect(startCommandFor('/srv/my quorum/node.json', config)).toBe(`quorum-node start --config '/srv/my quorum/node.json'`);
  });
});
