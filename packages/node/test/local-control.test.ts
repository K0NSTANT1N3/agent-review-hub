import { spawn } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { lstat, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseNodeConfig } from '@quorum/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InboxRecord } from '../src/journal.js';
import { controlPath, startLocalControl } from '../src/local-control.js';

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(disposers.splice(0).map((dispose) => dispose())); });

async function fixture(type: 'claude-code' | 'codex' | 'pi' | 'omp' | 'mock' | 'opencode' | 'kilo' = 'codex') {
  const dataDir = await mkdtemp(join(tmpdir(), 'qc-'));
  const config = parseNodeConfig({ agentId: 'local', token: 'node-token', leaderUrl: 'ws://leader.test',
    ownerName: 'Local', dataDir, workspaceDir: dataDir, repoRemoteUrl: '/repo', gitIdentity: { name: 'Test', email: 'test@example.com' },
    adapter: type === 'mock' ? { type, scriptPath: '/mock' } : type === 'opencode' ? { type, baseUrl: 'http://localhost:1', providerID: 'test', modelID: 'test' } : { type } });
  const session = { sid: 'sid', nativeId: 'private-native-id', worktree: '/worktree', profile: 'author', contextTokens: 0, state: 'idle', createdAt: 1 };
  let cancellation: InboxRecord | null = null;
  const journal = { lastSessionCommand: (_sid: string, type?: string) => type === 'task.cancel' ? cancellation : null, getSession: (sid: string) => sid === 'sid' ? session : null };
  const release = vi.fn(async () => undefined);
  const runner = { attach: vi.fn(async () => ({ release })) };
  const control = await startLocalControl(config, journal, runner);
  const sockets: Socket[] = [];
  disposers.push(async () => { for (const socket of sockets) socket.destroy(); await control.close(); await rm(dataDir, { recursive: true, force: true }); });
  function connect() {
    const socket = createConnection(controlPath(dataDir));
    sockets.push(socket);
    return async (patch: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.once('error', reject);
      socket.once('data', (data) => resolve(JSON.parse(data.toString()) as Record<string, unknown>));
      socket.write(JSON.stringify({ token: 'node-token', agentId: 'local', leaderUrl: 'http://leader.test', sid: 'sid', taskId: 12, action: 'check', ...patch }) + '\n');
    });
  }
  return { connect, config, journal, runner, release, setCancellation: (value: InboxRecord) => { cancellation = value; } };
}

describe('local control socket lifecycle', () => {
  it.skipIf(process.platform === 'win32')('replaces a socket a crashed Node left behind', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'qc-'));
    const path = controlPath(dataDir);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // A killed process leaves its Unix socket file behind; nothing listens on it.
    const child = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(path)}, () => console.log('up'))`], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    expect((await lstat(path)).isSocket()).toBe(true);
    const config = parseNodeConfig({ agentId: 'local', token: 'node-token', leaderUrl: 'ws://leader.test', ownerName: 'Local', dataDir, workspaceDir: dataDir,
      repoRemoteUrl: '/repo', gitIdentity: { name: 'Test', email: 'test@example.com' }, adapter: { type: 'codex' } });
    const control = await startLocalControl(config, { lastSessionCommand: () => null, getSession: () => null }, { attach: vi.fn() });
    disposers.push(async () => { await control.close(); await rm(dataDir, { recursive: true, force: true }); });
    expect((await lstat(path)).isSocket()).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('refuses to start while another Node serves the same data directory', async () => {
    const f = await fixture();
    await expect(startLocalControl(f.config, f.journal, f.runner)).rejects.toThrow(/in use/);
    expect(await f.connect()()).toMatchObject({ ok: true });
  });
});

describe('owner-only local control', () => {
  it.skipIf(process.platform === 'win32')('keeps socket paths short for deeply nested Node data directories', () => {
    const path = controlPath('/very-long-data-directory'.repeat(20));
    expect(Buffer.byteLength(path)).toBeLessThan(104);
    expect(path).toMatch(/[a-f0-9]{24}\.sock$/);
  });

  it('authenticates with Node token and refuses remote agents, Leaders and sessions', async () => {
    const f = await fixture();
    const request = f.connect();
    expect(await request({ token: 'api-token' })).toMatchObject({ ok: false, error: expect.stringContaining('authentication refused') });
    expect(await request({ agentId: 'remote' })).toMatchObject({ ok: false, error: expect.stringContaining('Remote session') });
    expect(await request({ leaderUrl: 'https://other.test' })).toMatchObject({ ok: false, error: expect.stringContaining('Remote session') });
    expect(await request({ sid: 'remote' })).toMatchObject({ ok: false, error: expect.stringContaining('Remote session') });
    expect(f.runner.attach).not.toHaveBeenCalled();
    expect(await request()).toEqual({ ok: true });
    if (process.platform !== 'win32') {
      expect((await stat(controlPath(f.config.dataDir))).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(controlPath(f.config.dataDir)))).mode & 0o777).toBe(0o700);
    }
  });

  it.each([
    ['claude-code', 'claude', '--resume'], ['codex', 'codex', 'resume'], ['pi', 'pi', '--session-id'], ['omp', 'omp', '--resume'],
  ] as const)('returns exact %s native resume command only after drain/lock', async (type, binary, flag) => {
    const f = await fixture(type);
    const request = f.connect();
    await request();
    const response = await request({ action: 'acquire' });
    expect(response).toMatchObject({ ok: true, command: { adapter: type, binary, argv: [flag, 'private-native-id'], cwd: '/worktree' } });
    if (type === 'codex') expect(response.command).toMatchObject({ codexHome: join(f.config.dataDir, 'codex-home') });
    expect(f.runner.attach).toHaveBeenCalledWith('sid', 12);
    expect(await request({ action: 'release' })).toEqual({ ok: true });
    expect(f.release).toHaveBeenCalledOnce();
  });

  it.each(['mock', 'opencode', 'kilo'] as const)('explains unsupported %s adapter', async (type) => {
    const f = await fixture(type);
    expect(await f.connect()()).toMatchObject({ ok: false, error: `Adapter ${type} does not support native resume.` });
  });

  it.each(['reviewer', 'directive'])('refuses to attach a %s session, which must stay read-only', async (profile) => {
    const f = await fixture();
    (f.journal.getSession('sid') as { profile: string }).profile = profile;
    expect(await f.connect()()).toMatchObject({ ok: false, error: expect.stringContaining('Only author sessions') });
    expect(f.runner.attach).not.toHaveBeenCalled();
  });

  it('waits for the fresh pause cancellation cleanup before acquiring', async () => {
    const f = await fixture();
    const request = f.connect();
    await request();
    const acquisition = request({ action: 'acquire', pausedFromState: 'AUTHORING' });
    const cancel: InboxRecord = { msgId: 'cancel', cmd: { type: 'task.cancel', sid: 'sid', taskId: 12 }, state: 'running', resultEvtMsgId: null, receivedAt: 1, finishedAt: null };
    f.setCancellation(cancel);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(f.runner.attach).not.toHaveBeenCalled();
    f.setCancellation({ ...cancel, state: 'done' });
    expect(await acquisition).toMatchObject({ ok: true });
    expect(f.runner.attach).toHaveBeenCalledWith('sid', 12);
    await request({ action: 'release' });
  });

  it('guards abandoned connections', async () => {
    const f = await fixture();
    const request = f.connect();
    await request();
    await request({ action: 'acquire' });
    const socket = createConnection(controlPath(f.config.dataDir));
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    const send = async (action: string) => {
      const response = new Promise<void>((resolve) => socket.once('data', () => resolve()));
      socket.write(JSON.stringify({ token: 'node-token', agentId: 'local', leaderUrl: 'http://leader.test', sid: 'sid', taskId: 12, action }) + '\n');
      await response;
    };
    await send('check');
    await send('acquire');
    socket.destroy();
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledWith(true));
  });
});
