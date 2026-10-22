import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addAgent, startLeader } from '@quorum/leader';
import { CustomAdapterConfigSchema, type NodeConfig, type OwnerSettings } from '@quorum/protocol';
import { createTokenRequest } from '../src/shared/cli-tokens.js';
import { DEFAULT_SETTINGS } from '../src/shared/ipc.js';
import { agentIdFor, decodeJoinCode, encodeJoinCode, httpBaseFromLeaderUrl, isEncryptedLeaderUrl, isValidPublicHost, publicLeaderUrl } from '../src/main/join-code.js';
import { networkInterfaces } from 'node:os';
import { startDaemon } from '@quorum/node';
import { Services, type DaemonHandleLike, type ServiceDeps } from '../src/main/services.js';

let dir: string;
let bare: string;
let started: NodeConfig[];
let updates: Partial<OwnerSettings>[];
let live: number;
let maxLive: number;
let rejects: ((reason: string) => void)[];
const services: Services[] = [];

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Slow start and stop widen the window in which overlapping lifecycle calls used to race.
const fakeDaemon = (): ServiceDeps['startDaemon'] => async (config, opts) => {
  await tick(20);
  started.push(config);
  if (opts.onReject !== undefined) rejects.push(opts.onReject);
  live += 1;
  maxLive = Math.max(maxLive, live);
  let stopped = false;
  const handle: DaemonHandleLike = {
    stop: async () => {
      await tick(20);
      if (!stopped) live -= 1;
      stopped = true;
    },
    status: () => null,
    updateSettings: (p) => updates.push(p),
  };
  return handle;
};

function deps(): ServiceDeps {
  return {
    startLeader: (c) => startLeader(c, { logger: { debug() {}, info() {}, warn() {}, error() {} } }),
    addAgent,
    startDaemon: fakeDaemon(),
    secrets: { encrypt: (s) => `plain:${s}`, decrypt: (s) => s.slice(6), isEncrypted: (s) => !s.startsWith('plain:') },
  };
}

function make(name: string): Services {
  const s = new Services(join(dir, name), deps());
  services.push(s);
  return s;
}

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address() as { port: number };
      srv.close(() => resolve(a.port));
    });
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quorum-desktop-'));
  bare = join(dir, 'remote.git');
  const seed = join(dir, 'seed');
  execFileSync('git', ['init', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['init', '-b', 'main', seed]);
  writeFileSync(join(seed, 'README.md'), 'hi\n');
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'init'], { cwd: seed });
  execFileSync('git', ['push', bare, 'main'], { cwd: seed });
  started = [];
  updates = [];
  live = 0;
  maxLive = 0;
  rejects = [];
});

async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await tick(25);
  }
}

async function hosted(name = 'host'): Promise<{ host: Services; port: number }> {
  const host = make(name);
  const port = await freePort();
  await host.setupHost({ ownerName: 'Ana', repoRemoteUrl: bare, mainBranch: 'main', port, publicHost: '127.0.0.1', settings: DEFAULT_SETTINGS });
  return { host, port };
}

afterEach(async () => {
  for (const s of services.splice(0)) await s.stopAll();
  rmSync(dir, { recursive: true, force: true });
});

describe('isValidPublicHost', () => {
  it('accepts bare hosts, bracketed IPv6 and tunnel URLs; rejects ports and paths on bare hosts', () => {
    for (const ok of ['', '192.168.1.5', 'devbox.local', '[fe80::1]', 'https://abc.trycloudflare.com', 'wss://leader.example.com/x']) {
      expect(isValidPublicHost(ok)).toBe(true);
    }
    for (const bad of ['192.168.1.5:7420', 'host/path', 'two words', 'fe80::1', 'https://']) {
      expect(isValidPublicHost(bad)).toBe(false);
    }
  });
});

describe('join codes', () => {
  it('round-trips and validates', () => {
    const code = encodeJoinCode({ leaderUrl: 'ws://10.0.0.5:7420/ws/node', agentId: 'bo-agent', ownerName: 'Bo', token: 'qrm_x', repoRemoteUrl: 'git@x:y.git' });
    expect(code.startsWith('quorum1.')).toBe(true);
    expect(decodeJoinCode(`  ${code}\n`)).toMatchObject({ v: 1, agentId: 'bo-agent', token: 'qrm_x' });
    expect(() => decodeJoinCode('hello')).toThrow(/Not a Quorum join code/);
    expect(() => decodeJoinCode('quorum1.!!!')).toThrow();
    expect(httpBaseFromLeaderUrl('wss://h.example:8443/ws/node')).toBe('https://h.example:8443');
    expect(agentIdFor('Ána Smith!')).toBe('ana-smith-agent');
  });
});

describe('public Leader URL', () => {
  it('builds ws:// for hosts/IPs and wss:// for tunnel URLs', () => {
    expect(publicLeaderUrl('192.168.1.20', 7420)).toBe('ws://192.168.1.20:7420/ws/node');
    expect(publicLeaderUrl('https://abc.trycloudflare.com', 7420)).toBe('wss://abc.trycloudflare.com/ws/node');
    expect(publicLeaderUrl('https://abc.trycloudflare.com/', 7420)).toBe('wss://abc.trycloudflare.com/ws/node');
    expect(publicLeaderUrl('http://box.tailnet.ts.net:7420', 7420)).toBe('ws://box.tailnet.ts.net:7420/ws/node');
    expect(isEncryptedLeaderUrl(publicLeaderUrl('https://x.example', 1))).toBe(true);
    expect(isEncryptedLeaderUrl(publicLeaderUrl('10.0.0.2', 1))).toBe(false);
    expect(publicLeaderUrl('https://leader.example.com', 7420)).toBe('wss://leader.example.com/ws/node');
  });
});

const lanIp = Object.values(networkInterfaces())
  .flat()
  .find((a) => a !== undefined && a.family === 'IPv4' && !a.internal)?.address;

describe.skipIf(lanIp === undefined)('joining over the LAN with the real Node daemon', () => {
  it('invites and joins a teammate over the LAN address', async () => {
    const host = new Services(join(dir, 'lan-host'), { ...deps(), startDaemon: (c, o) => startDaemon(c, o) });
    services.push(host);
    const port = await freePort();
    await host.setupHost({ ownerName: 'Ana', repoRemoteUrl: bare, mainBranch: 'main', port, publicHost: lanIp!, settings: DEFAULT_SETTINGS });
    const { joinCode } = await host.invite({ agentId: '', ownerName: 'Bo' });
    expect(decodeJoinCode(joinCode).leaderUrl).toBe(`ws://${lanIp}:${port}/ws/node`);
    const member = new Services(join(dir, 'lan-member'), { ...deps(), startDaemon: (c, o) => startDaemon(c, o) });
    services.push(member);
    await member.setupJoin({ joinCode, settings: DEFAULT_SETTINGS });
    let online = false;
    for (let i = 0; i < 50 && !online; i += 1) {
      const result = await host.api('listAgents');
      online = result.ok && result.data.agents.some((a) => a.id === 'bo-agent' && a.status === 'online');
      if (!online) await tick(100);
    }
    expect(online).toBe(true);
    expect(member.state()).toMatchObject({ encrypted: false, connectionWarning: null, leaderNetwork: 'local' });
  });
});

describe('plaintext public and encrypted tunnel connections', () => {
  it('allows a public address and exposes a clear warning in app state', async () => {
    const host = make('public-host');
    const port = await freePort();
    await host.setupHost({ ownerName: 'Ana', repoRemoteUrl: bare, mainBranch: 'main', port, publicHost: '203.0.113.7', settings: DEFAULT_SETTINGS });
    const { joinCode } = await host.invite({ agentId: '', ownerName: 'Bo' });
    expect(decodeJoinCode(joinCode).leaderUrl).toBe(`ws://203.0.113.7:${port}/ws/node`);
    const member = make('public-member');
    await member.setupJoin({ joinCode, settings: DEFAULT_SETTINGS });
    expect(member.state()).toMatchObject({ encrypted: false, leaderNetwork: 'public', connectionWarning: 'This public connection is not encrypted; prefer a VPN or TLS tunnel.' });
  });

  it('keeps tunnel join codes encrypted and warning free', async () => {
    const host = make('tunnel-host');
    await host.setupHost({ ownerName: 'Ana', repoRemoteUrl: bare, mainBranch: 'main', port: await freePort(), publicHost: 'https://leader.example.com', settings: DEFAULT_SETTINGS });
    const { joinCode } = await host.invite({ agentId: '', ownerName: 'Bo' });
    expect(decodeJoinCode(joinCode).leaderUrl).toBe('wss://leader.example.com/ws/node');
    const member = make('tunnel-member');
    await member.setupJoin({ joinCode, settings: DEFAULT_SETTINGS });
    expect(member.state()).toMatchObject({ encrypted: true, connectionWarning: null });
  });
});

describe.skipIf(lanIp === undefined)('restricting the Leader to one address', () => {
  it('listens only on the chosen address; the host agent still connects through it', async () => {
    const real: ServiceDeps = { ...deps(), startDaemon: (c, o) => startDaemon(c, o) };
    const mock = join(dir, 'mock.json');
    writeFileSync(mock, JSON.stringify({ author: [], reviewer: [] }));
    const settings = { ...DEFAULT_SETTINGS, adapter: { type: 'mock' as const, scriptPath: mock, contextWindow: 200000 } };
    const host = new Services(join(dir, 'restricted'), real);
    services.push(host);
    const port = await freePort();
    const state = await host.setupHost({ ownerName: 'Ana', repoRemoteUrl: bare, mainBranch: 'main', port, publicHost: lanIp!, restrictToIp: lanIp!, settings });
    expect(state.leader).toMatchObject({ running: true, restrictedTo: lanIp });
    expect(state.leaderNetwork).toBe('local');
    expect(await (await fetch(`http://${lanIp}:${port}/api/health`)).json()).toEqual({ ok: true });
    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
    let online = false;
    for (let i = 0; i < 50 && !online; i += 1) {
      const r = await host.api('listAgents');
      online = r.ok && r.data.agents.find((a) => a.id === 'ana-agent')?.status === 'online';
      if (!online) await new Promise((r) => setTimeout(r, 200));
    }
    expect(online).toBe(true);
  });
});

describe('Services', () => {
  it('explains a restricted address that is not on this computer (VPN not connected)', async () => {
    const host = make('novpn');
    await expect(
      host.setupHost({ ownerName: 'Ana', repoRemoteUrl: bare, mainBranch: 'main', port: await freePort(), publicHost: '10.255.255.254', restrictToIp: '10.255.255.254', settings: DEFAULT_SETTINGS }),
    ).rejects.toThrow(/not on this computer right now\. Connect your VPN/);
    expect(host.state().configured).toBe(false);
  });

  it('host setup starts the Leader, registers the host agent and starts the Node pointed at it', async () => {
    const host = make('host');
    expect((await host.boot()).configured).toBe(false);
    const port = await freePort();
    const state = await host.setupHost({ ownerName: 'Ana', repoRemoteUrl: bare, mainBranch: 'main', port, publicHost: '10.1.2.3', settings: DEFAULT_SETTINGS });
    expect(state).toMatchObject({ configured: true, mode: 'host', agentId: 'ana-agent', isAdmin: true, leader: { running: true, port, publicUrl: `ws://10.1.2.3:${port}/ws/node` } });
    expect(started[0]).toMatchObject({ leaderUrl: `ws://127.0.0.1:${port}/ws/node`, agentId: 'ana-agent', ownerName: 'Ana', repoRemoteUrl: bare });

    const created = await host.api('createTask', { body: { title: 'From desktop', description: 'd' } });
    expect(created).toMatchObject({ ok: true, data: { state: 'QUEUED', requesterOwner: 'Ana' } });
    const bad = await host.api('getTask', { id: 999 });
    expect(bad).toMatchObject({ ok: false, status: 404, error: 'NOT_FOUND' });
  });

  it('invite produces a join code that a second instance uses to join', async () => {
    const host = make('host');
    const port = await freePort();
    await host.setupHost({ ownerName: 'Ana', repoRemoteUrl: bare, mainBranch: 'main', port, publicHost: '127.0.0.1', settings: DEFAULT_SETTINGS });
    const { joinCode } = await host.invite({ agentId: '', ownerName: 'Bo' });
    expect(decodeJoinCode(joinCode)).toMatchObject({ agentId: 'bo-agent', ownerName: 'Bo', repoRemoteUrl: bare });

    const member = make('member');
    const state = await member.setupJoin({ joinCode, settings: { ...DEFAULT_SETTINGS, lendMode: 'always' } });
    expect(state).toMatchObject({ mode: 'join', agentId: 'bo-agent', isAdmin: false, leader: null });
    const agents = await member.api('listAgents');
    expect(agents.ok && agents.data.agents.map((a) => a.id).sort()).toEqual(['ana-agent', 'bo-agent']);
    await expect(member.invite({ agentId: '', ownerName: 'X' })).rejects.toThrow(/Only the host/);
  });

  it('persists the setup and restores it on boot; settings update live; reset forgets it', async () => {
    const port = await freePort();
    const first = make('host');
    await first.setupHost({ ownerName: 'Ana', repoRemoteUrl: bare, mainBranch: 'main', port, publicHost: '127.0.0.1', settings: DEFAULT_SETTINGS });
    await first.stopAll();

    const again = new Services(join(dir, 'host'), deps());
    services.push(again);
    const restored = await again.boot();
    expect(restored).toMatchObject({ configured: true, mode: 'host', leader: { running: true } });

    await again.updateSettings({ ...DEFAULT_SETTINGS, paused: true, lendMode: 'never' });
    expect(updates.at(-1)).toMatchObject({ paused: true, lendMode: 'never' });
    const before = started.length;
    await again.updateSettings({ ...DEFAULT_SETTINGS, adapter: { type: 'mock', scriptPath: '/tmp/s.json', contextWindow: 1000 } });
    expect(started.length).toBe(before + 1);

    expect((await again.reset()).configured).toBe(false);
  });

  it('reports a bad repository without saving anything', async () => {
    const host = make('host');
    const port = await freePort();
    await expect(
      host.setupHost({ ownerName: 'Ana', repoRemoteUrl: join(dir, 'missing.git'), mainBranch: 'main', port, publicHost: '127.0.0.1', settings: DEFAULT_SETTINGS }),
    ).rejects.toThrow(/clone/);
    expect(host.state().configured).toBe(false);
  });

  it('surfaces a Node start failure instead of crashing', async () => {
    const host = new Services(join(dir, 'h2'), { ...deps(), startDaemon: async () => { throw new Error('startDaemon: not implemented yet (N8)'); } });
    services.push(host);
    const state = await host.setupHost({ ownerName: 'Ana', repoRemoteUrl: bare, mainBranch: 'main', port: await freePort(), publicHost: '127.0.0.1', settings: DEFAULT_SETTINGS });
    expect(state.node).toMatchObject({ running: false, error: expect.stringContaining('not implemented') });
    expect(state.leader?.running).toBe(true);
  });

  it('runs lifecycle calls one at a time: concurrent restarts start exactly one daemon and one Leader', async () => {
    const { host } = await hosted();
    const before = started.length;
    const states = await Promise.all([host.restart(), host.restart(), host.restart()]);
    expect(started.length).toBe(before + 1);
    expect(live).toBe(1);
    expect(maxLive).toBe(1);
    for (const state of states) expect(state).toMatchObject({ busy: false, leader: { running: true, error: null }, node: { running: true } });
  });

  it('serializes boot, settings and restart so two daemons never run at once', async () => {
    const { host } = await hosted();
    await host.stopAll();
    const again = new Services(join(dir, 'host'), deps());
    services.push(again);
    const booting = again.boot();
    expect(again.state().busy).toBe(true);
    const restarting = again.restart();
    const updating = again.updateSettings({ ...DEFAULT_SETTINGS, adapter: { type: 'mock', scriptPath: '/tmp/s.json', contextWindow: 1000 } });
    await Promise.all([booting, restarting, updating]);
    expect(maxLive).toBe(1);
    expect(live).toBe(1);
    expect(again.state()).toMatchObject({ busy: false, leader: { running: true, error: null }, node: { running: true } });
  });

  it('reset deletes the Node clone and journal but keeps Leader data unless asked', async () => {
    const { host } = await hosted();
    const data = join(dir, 'host');
    for (const sub of ['workspace', 'node']) mkdirSync(join(data, sub), { recursive: true });
    expect(existsSync(join(data, 'leader', 'leader.db'))).toBe(true);
    const state = await host.reset();
    expect(state).toMatchObject({ configured: false, node: { running: false } });
    expect(existsSync(join(data, 'workspace'))).toBe(false);
    expect(existsSync(join(data, 'node'))).toBe(false);
    expect(existsSync(join(data, 'quorum-desktop.json'))).toBe(false);
    expect(existsSync(join(data, 'leader', 'leader.db'))).toBe(true);
    expect(live).toBe(0);

    const { host: second } = await hosted('second');
    const data2 = join(dir, 'second');
    await second.reset({ deleteLeaderData: true });
    expect(existsSync(join(data2, 'leader'))).toBe(false);
  });

  it('checks CLI binaries including Kilo without probing arbitrary custom commands', async () => {
    const { host } = await hosted();
    for (const type of ['codex', 'pi', 'omp', 'kilo'] as const) {
      await host.updateSettings({ ...DEFAULT_SETTINGS, adapter: { type, binaryPath: process.execPath, contextWindow: 200000 } });
      const result = await host.checkAgent();
      expect(result.ok).toBe(true);
      expect(result.detail).toContain(type);
    }
    const profile = { command: '/missing/never-execute', args: ['{prompt}'] };
    await host.updateSettings({ ...DEFAULT_SETTINGS, adapter: CustomAdapterConfigSchema.parse({
      type: 'custom', profiles: { author: profile, reviewer: profile, directive: profile },
      sessionIdPath: 'id', mapping: { text: { event: 'text', text: 'text' }, turn_end: { event: 'done' } },
    }) });
    expect(await host.checkAgent()).toMatchObject({ ok: true, detail: expect.stringContaining('does not probe') });
  });

  it('stops the agent and reports an auth error when the Leader rejects the daemon', async () => {
    const { host } = await hosted();
    expect(host.state()).toMatchObject({ authError: null, node: { running: true } });
    rejects.at(-1)?.('agent token revoked');
    await until(() => !host.state().node.running);
    expect(host.state()).toMatchObject({
      node: { running: false, error: expect.stringContaining('agent token revoked') },
      authError: expect.stringContaining('agent token revoked'),
    });
    expect(live).toBe(0);
  });

  it('stops reconnecting the UI stream and reports an auth error when the Leader refuses the token', async () => {
    const { port } = await hosted();
    const joinCode = encodeJoinCode({ leaderUrl: `ws://127.0.0.1:${port}/ws/node`, agentId: 'bo-agent', ownerName: 'Bo', token: 'qrm_revoked', repoRemoteUrl: bare });
    const member = make('member');
    await member.setupJoin({ joinCode, settings: DEFAULT_SETTINGS });
    await until(() => member.state().authError !== null);
    expect(member.state()).toMatchObject({ connected: false, authError: expect.stringContaining('new join code') });
  });

  it('reports plain-text token storage and survives a token that can no longer be decrypted', async () => {
    const { host } = await hosted();
    expect(host.state().secretsEncrypted).toBe(false);
    await host.stopAll();

    const broken = new Services(join(dir, 'host'), {
      ...deps(),
      secrets: { encrypt: (s) => s, decrypt: () => { throw new Error('keychain locked'); }, isEncrypted: () => true },
    });
    services.push(broken);
    const state = await broken.boot();
    expect(state).toMatchObject({
      configured: true,
      secretsEncrypted: true,
      authError: expect.stringContaining('keychain locked'),
      node: { running: false, error: expect.stringContaining('keychain locked') },
    });
    expect(await broken.api('listAgents')).toMatchObject({ ok: false, error: 'TOKEN_UNREADABLE' });
  });

  it('lets a teammate mint an owner token with the app credential and save it for quorum tui with mode 0600', async () => {
    const { host } = await hosted();
    const { joinCode } = await host.invite({ agentId: '', ownerName: 'Bo' });
    const member = make('member');
    await member.setupJoin({ joinCode, settings: DEFAULT_SETTINGS });

    const minted = await member.api('createApiToken', { body: createTokenRequest('', 'owner') });
    if (!minted.ok) throw new Error(minted.message);
    expect(minted.data).toMatchObject({ scope: 'owner', agentId: 'bo-agent', label: 'quorum tui' });
    const listed = await member.api('listApiTokens');
    expect(listed.ok && listed.data.tokens.map((t) => [t.id, t.scope])).toEqual([[minted.data.id, 'owner']]);

    const path = join(dir, 'xdg', 'quorum', 'cli.json');
    expect(member.saveTuiToken(minted.data.token, path)).toBe(path);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ url: member.state().apiUrl, token: minted.data.token });
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);

    expect(() => member.saveTuiToken('not-a-token', path)).toThrow(/not a Quorum API token/);
    expect(() => make('fresh').saveTuiToken(minted.data.token, path)).toThrow(/not set up/);

    const revoked = await member.api('revokeApiToken', { id: minted.data.id });
    expect(revoked).toMatchObject({ ok: true, data: { scope: 'owner', revokedAt: expect.any(Number) } });
  });
});
