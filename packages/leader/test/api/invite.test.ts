import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseLeaderConfig, type LeaderConfig } from '@quorum/protocol';
import { decodeJoinCode } from '@quorum/protocol/join-code';
import { addAgent, listAgents, revokeAgent } from '../../src/index.js';
import { createInvite, inviteLeaderUrl } from '../../src/invite.js';
import { openDatabase } from '../../src/db/repo.js';

let dir: string;
let config: LeaderConfig;

const configWith = (extra: Record<string, unknown> = {}): LeaderConfig =>
  parseLeaderConfig({ dbPath: join(dir, 'leader.db'), repo: { remoteUrl: 'git@github.com:acme/app.git' }, ...extra });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quorum-invite-'));
  config = configWith();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('quorum-leader invite', () => {
  it('registers the agent and returns a join code the desktop decoder accepts', async () => {
    const invite = await createInvite(config, { name: 'Ana Smith', publicHost: '203.0.113.7' });
    const code = decodeJoinCode(invite.joinCode);
    expect(code).toEqual({
      v: 1,
      leaderUrl: 'ws://203.0.113.7:7420/ws/node',
      agentId: 'ana-smith-agent',
      ownerName: 'Ana Smith',
      token: expect.stringMatching(/^qrm_/) as string,
      repoRemoteUrl: 'git@github.com:acme/app.git',
    });
    expect(await listAgents(config.dbPath)).toMatchObject([{ id: 'ana-smith-agent', owner: 'Ana Smith', revoked: false }]);
    const db = openDatabase(config.dbPath);
    try {
      expect(db.agents.get('ana-smith-agent')?.token_hash).toBe(createHash('sha256').update(code.token).digest('hex'));
    } finally {
      db.close();
    }
    expect(invite.warnings.some((w) => w.includes('unencrypted ws://'))).toBe(true);
  });

  it('turns a tunnel URL into wss:// with no port, and a TLS Leader into wss:// on its port', () => {
    expect(inviteLeaderUrl(config, 'https://xyz.trycloudflare.com', 7420)).toBe('wss://xyz.trycloudflare.com/ws/node');
    const tls = configWith({ tls: { certFile: '/etc/quorum/cert.pem', keyFile: '/etc/quorum/key.pem' } });
    expect(inviteLeaderUrl(tls, 'quorum.example.com', 7420)).toBe('wss://quorum.example.com:7420/ws/node');
    expect(inviteLeaderUrl(tls, 'quorum.example.com', 443)).toBe('wss://quorum.example.com/ws/node');
    expect(() => inviteLeaderUrl(config, 'host:9000', 7420)).toThrow(/--public-host must be/);
  });

  it('honours --id and --port and warns when no public host is given', async () => {
    const invite = await createInvite(config, { name: 'Bo', id: 'bo-vps', port: 9000 });
    expect(invite.agentId).toBe('bo-vps');
    expect(invite.leaderUrl).toBe('ws://127.0.0.1:9000/ws/node');
    expect(invite.warnings.some((w) => w.startsWith('No --public-host given'))).toBe(true);
    expect(invite.warnings.some((w) => w.includes('unencrypted'))).toBe(false);
  });

  it.each([
    ['::1', 'ws'],
    ['2001:db8::7', 'ws'],
    ['::1', 'wss'],
    ['2001:db8::7', 'wss'],
  ])('defaults to a bracketed IPv6 listen address %s over %s', async (host, scheme) => {
    const ipv6 = configWith({
      listen: { host, port: 7420 },
      ...(scheme === 'wss' ? { tls: { certFile: '/etc/quorum/cert.pem', keyFile: '/etc/quorum/key.pem' } } : {}),
    });
    const invite = await createInvite(ipv6, { name: 'Bo' });
    expect(decodeJoinCode(invite.joinCode).leaderUrl).toBe(`${scheme}://[${host}]:7420/ws/node`);
  });

  it('refuses to rotate an existing agent token unless --rotate is given', async () => {
    const first = decodeJoinCode((await createInvite(config, { name: 'Bo', publicHost: 'h.example' })).joinCode);
    await expect(createInvite(config, { name: 'Bo', publicHost: 'h.example' })).rejects.toThrow(/already exists. Pass --rotate/);
    const second = decodeJoinCode((await createInvite(config, { name: 'Bo', publicHost: 'h.example', rotate: true })).joinCode);
    expect(second.token).not.toBe(first.token);
  });

  it('accepts only one concurrent invite for a new agent without --rotate', async () => {
    const results = await Promise.allSettled([
      createInvite(config, { name: 'Bo', publicHost: 'h.example' }),
      createInvite(config, { name: 'Bo', publicHost: 'h.example' }),
    ]);
    const accepted = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ message: expect.stringMatching(/already exists. Pass --rotate/) });

    const code = decodeJoinCode(accepted[0]!.value.joinCode);
    const db = openDatabase(config.dbPath);
    try {
      expect(db.agents.get(code.agentId)?.token_hash).toBe(createHash('sha256').update(code.token).digest('hex'));
    } finally {
      db.close();
    }
  });

  it('can invite a revoked agent again without --rotate', async () => {
    const first = decodeJoinCode((await createInvite(config, { name: 'Bo', publicHost: 'h.example' })).joinCode);
    await revokeAgent(config.dbPath, first.agentId);
    const second = decodeJoinCode((await createInvite(config, { name: 'Bo', publicHost: 'h.example' })).joinCode);
    expect(second.token).not.toBe(first.token);
    expect(await listAgents(config.dbPath)).toMatchObject([{ id: first.agentId, revoked: false }]);
  });

  it('preserves addAgent token rotation by default for existing callers', async () => {
    const first = await addAgent(config.dbPath, { id: 'bo-agent', owner: 'Bo' });
    const second = await addAgent(config.dbPath, { id: 'bo-agent', owner: 'Bo' });
    expect(second.token).not.toBe(first.token);
  });

  it('warns when the repo URL is a local path teammates cannot clone', async () => {
    const local = configWith({ repo: { remoteUrl: '/srv/git/app.git' } });
    const invite = await createInvite(local, { name: 'Cy', publicHost: 'https://t.example.com' });
    expect(invite.warnings.some((w) => w.includes('looks like a local path'))).toBe(true);
    expect(invite.warnings.some((w) => w.includes('unencrypted'))).toBe(false);
  });
});
