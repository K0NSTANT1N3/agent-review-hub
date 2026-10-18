import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addAgent, startLeader } from '@quorum/leader';
import type { NodeConfig, OwnerSettings } from '@quorum/protocol';
import { DEFAULT_SETTINGS } from '../src/shared/ipc.js';
import { agentIdFor, decodeJoinCode, encodeJoinCode, httpBaseFromLeaderUrl, isEncryptedLeaderUrl, publicLeaderUrl } from '../src/main/join-code.js';
import { networkInterfaces } from 'node:os';
import { startDaemon } from '@quorum/node';
import { Services, type DaemonHandleLike, type ServiceDeps } from '../src/main/services.js';

let dir: string;
let bare: string;
let started: NodeConfig[];
let updates: Partial<OwnerSettings>[];
const services: Services[] = [];

const fakeDaemon = (): ServiceDeps['startDaemon'] => async (config) => {
  started.push(config);
  const handle: DaemonHandleLike = { stop: async () => {}, status: () => null, updateSettings: (p) => updates.push(p) };
  return handle;
};

function deps(): ServiceDeps {
  return {
    startLeader: (c) => startLeader(c, { logger: { debug() {}, info() {}, warn() {}, error() {} } }),
    addAgent,
    startDaemon: fakeDaemon(),
    secrets: { encrypt: (s) => `plain:${s}`, decrypt: (s) => s.slice(6) },
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
});

afterEach(async () => {
  for (const s of services.splice(0)) await s.stopAll();
  rmSync(dir, { recursive: true, force: true });
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
  });
});

const lanIp = Object.values(networkInterfaces())
  .flat()
  .find((a) => a !== undefined && a.family === 'IPv4' && !a.internal)?.address;

describe.skipIf(lanIp === undefined)('joining over the LAN with the real Node daemon', () => {
  it('a member connects to the host through its LAN address (plain ws://)', async () => {
    const real: ServiceDeps = { ...deps(), startDaemon: (c, o) => startDaemon(c, o) };
    const mock = join(dir, 'mock.json');
    writeFileSync(mock, JSON.stringify({ author: [], reviewer: [] }));
    const settings = { ...DEFAULT_SETTINGS, adapter: { type: 'mock' as const, scriptPath: mock, contextWindow: 200000 } };
    const host = new Services(join(dir, 'lan-host'), real);
    services.push(host);
    const port = await freePort();
    await host.setupHost({ ownerName: 'Ana', repoRemoteUrl: bare, mainBranch: 'main', port, publicHost: lanIp!, settings });
    const { joinCode } = await host.invite({ agentId: '', ownerName: 'Bo' });
    expect(decodeJoinCode(joinCode).leaderUrl).toBe(`ws://${lanIp}:${port}/ws/node`);

    const member = new Services(join(dir, 'lan-member'), real);
    services.push(member);
    const state = await member.setupJoin({ joinCode, settings });
    expect(state.node).toMatchObject({ running: true, error: null });
    let online = false;
    for (let i = 0; i < 50 && !online; i += 1) {
      const r = await host.api('listAgents');
      online = r.ok && r.data.agents.find((a) => a.id === 'bo-agent')?.status === 'online';
      if (!online) await new Promise((r) => setTimeout(r, 200));
    }
    expect(online).toBe(true);
  });
});

describe('Services', () => {
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
});
