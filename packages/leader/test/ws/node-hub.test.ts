import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseLeaderConfig, type Event, type HelloFrame, type NodeStatus, type SessionReport } from '@quorum/protocol';
import { LockManager } from '../../src/core/locks.js';
import { openDatabase, type LeaderDb, type SessionRow } from '../../src/db/repo.js';
import { NodeHub, type HubOptions } from '../../src/ws/node-hub.js';
import { DEFAULT_OWNER_SETTINGS, FakeNode } from '../helpers/fake-node.js';

let db: LeaderDb;
let hub: NodeHub;
let locks: LockManager;
let url: string;
let now: number;
let nodes: FakeNode[];
let directory: string | undefined;
const tokens = { alice: 'qrm_alice-test-secret', bob: 'qrm_bob-test-secret' };

function seed() {
  for (const id of ['alice', 'bob'] as const) {
    db.agents.insert({ id, owner_name: id, token_hash: createHash('sha256').update(tokens[id]).digest('hex'), created_at: now });
  }
  for (const [id, agent] of [['a', 'alice'], ['a2', 'alice'], ['b', 'bob']] as const) {
    db.sessions.insert({ id, agent_id: agent, state: 'opening', created_at: now, last_used_at: now });
  }
}

async function start(options: Partial<HubOptions> = {}, resendUnackedSec = 10) {
  locks = new LockManager(db, { leaseSec: 120, now: () => now, deliver: (agentId, frame) => { hub.deliver(agentId, frame); } });
  const config = parseLeaderConfig({
    listen: { host: '127.0.0.1', port: 0 }, dbPath: ':memory:',
    repo: { remoteUrl: 'file:///unused', mainBranch: 'main' }, timeouts: { resendUnackedSec },
  });
  hub = new NodeHub(db, config, { locks, now: () => now, ...options });
  const result = await hub.start();
  url = result.url;
  expect(result.port).toBeGreaterThan(0);
  expect(result.url).toBe(`ws://127.0.0.1:${result.port}`);
}

async function connect(id: keyof typeof tokens = 'alice', patch: Partial<HelloFrame> = {}) {
  const node = await FakeNode.connect(url, FakeNode.hello(id, tokens[id], patch));
  nodes.push(node);
  return node;
}

function report(sid: string, alive = true, contextTokens = 500): SessionReport {
  return { sid, alive, busy: false, contextTokens };
}

function status(patch: Partial<NodeStatus> = {}): NodeStatus {
  return { settings: { ...DEFAULT_OWNER_SETTINGS }, humanIdleSec: null, rateLimitedUntil: null, sessions: [], ...patch };
}

function lockAuthor(sid = 'a') {
  const task = db.tasks.insert({ title: 'Feature', description: 'Build', requester_agent_id: 'alice', author_agent_id: 'alice', author_session_id: sid, state: 'AUTHORING', created_at: now, updated_at: now, state_entered_at: now });
  locks.lockSession(sid, 'task', String(task.id), 'author');
  return task;
}

beforeEach(() => {
  db = openDatabase(':memory:');
  now = 100_000;
  nodes = [];
  directory = undefined;
  seed();
});

afterEach(async () => {
  await Promise.all(nodes.map((node) => node.close()));
  if (hub !== undefined) await hub.close();
  db.close();
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
});

describe('node authentication and connections', () => {
  it('authenticates by token hash, returns all negotiated settings, and stores owner settings', async () => {
    await start();
    const settings = { ...DEFAULT_OWNER_SETTINGS, maxSessions: 4, lendMode: 'always' as const, lendTokensPerDay: 12_345, paused: true, tags: ['typescript'], contextWindow: 100_000, idleThresholdSec: 90 };
    const node = await connect('alice', { settings });
    expect(await node.next('welcome')).toEqual({ kind: 'welcome', serverTime: now, heartbeatIntervalSec: 10, resendUnackedSec: 10, turnTimeoutSec: 1800, mainBranch: 'main' });
    expect(hub.ownerSettings('alice')).toEqual(settings);
    expect(hub.ownerSettings('unknown')).toBeUndefined();
    expect(db.agents.require('alice')).toMatchObject({ status: 'online', last_heartbeat_at: now, max_sessions: 4, lend_mode: 'always', lend_tokens_per_day: 12_345, paused: 1, tags: '["typescript"]', context_window: 100_000 });
    expect(db.agents.require('alice').token_hash).not.toBe(tokens.alice);
  });

  it.each(['bad_token', 'revoked', 'version_mismatch'] as const)('rejects %s without making the agent online', async (reason) => {
    await start();
    if (reason === 'revoked') db.agents.update('alice', { revoked: 1 });
    const node = await connect('alice', reason === 'bad_token' ? { token: 'wrong-token' } : reason === 'version_mismatch' ? { protocolVersion: 2 } : {});
    expect(await node.next('reject')).toEqual({ kind: 'reject', reason });
    expect(await node.waitClosed()).toBe(1008);
    expect(db.agents.require('alice').status).toBe('offline');
  });

  it('rejects an unknown agent', async () => {
    await start();
    const node = await connect('alice', { agentId: 'unknown' });
    expect((await node.next('reject')).reason).toBe('bad_token');
    expect(await node.waitClosed()).toBe(1008);
  });

  it('makes the new connection win without the old close marking it offline', async () => {
    await start();
    const old = await connect();
    await old.next('welcome');
    const replacement = await connect();
    await replacement.next('welcome');
    expect((await old.next('reject')).reason).toBe('already_connected');
    expect(await old.waitClosed()).toBe(1008);
    expect(db.agents.require('alice').status).toBe('online');
    const command = locks.sendToAgent('alice', { type: 'session.open', sid: 'a', profile: 'author' });
    expect((await replacement.next('cmd')).msgId).toBe(command.msgId);
    expect(old.frames.filter((frame) => frame.kind === 'cmd')).toHaveLength(0);
  });

  it('requires hello before heartbeat and rejects malformed JSON', async () => {
    await start();
    for (const invalid of [JSON.stringify({ kind: 'heartbeat', status: status() }), '{invalid-json']) {
      const node = await FakeNode.connect(url);
      nodes.push(node);
      node.sendRaw(invalid);
      expect(await node.waitClosed()).toBe(1008);
    }
    expect(db.agents.require('alice').status).toBe('offline');
  });
});

describe('hello and heartbeat reconciliation', () => {
  it('extends alive session leases and reports missing locked sessions on hello', async () => {
    const lost: { session: SessionRow; reason: string }[] = [];
    await start({ onSessionLost: (session, reason) => { lost.push({ session, reason }); } });
    lockAuthor();
    lockAuthor('a2');
    now += 1000;
    const node = await connect('alice', { sessions: [report('a', true, 900)] });
    await node.next('welcome');
    expect(db.sessions.require('a')).toMatchObject({ state: 'locked', lease_expires_at: now + 120_000, context_tokens: 900 });
    expect(db.sessions.require('a2')).toMatchObject({ state: 'lost', lock_kind: null, lock_ref: null, lease_expires_at: null });
    expect(lost).toHaveLength(1);
    expect(lost[0]).toMatchObject({ session: { id: 'a2', lock_kind: 'task', lock_role: 'author' }, reason: 'heartbeat_missing' });
  });

  it('persists status and settings, extends alive leases, and loses false or missing sessions', async () => {
    const lost: string[] = [];
    let changes = 0;
    await start({ onSessionLost: (session) => { lost.push(session.id); }, onStatusChanged: () => { changes += 1; } });
    lockAuthor();
    lockAuthor('a2');
    const node = await connect('alice', { sessions: [report('a'), report('a2')] });
    await node.next('welcome');
    now += 5000;
    const settings = { ...DEFAULT_OWNER_SETTINGS, paused: true, lendMode: 'never' as const, idleThresholdSec: 45 };
    node.heartbeat(status({ settings, humanIdleSec: 333, rateLimitedUntil: now + 60_000, sessions: [report('a', true, 777), report('a2', false), report('b', true, 999)] }));
    await vi.waitFor(() => { expect(db.agents.require('alice').human_idle_sec).toBe(333); });
    expect(db.agents.require('alice')).toMatchObject({ paused: 1, lend_mode: 'never', rate_limited_until: now + 60_000, last_heartbeat_at: now });
    expect(hub.ownerSettings('alice')).toEqual(settings);
    expect(db.sessions.require('a')).toMatchObject({ state: 'locked', lease_expires_at: now + 120_000, context_tokens: 777 });
    expect(db.sessions.require('a2').state).toBe('lost');
    expect(db.sessions.require('b').context_tokens).toBe(0);
    expect(lost).toEqual(['a2']);
    expect(changes).toBeGreaterThanOrEqual(2);
    node.heartbeat(status({ sessions: [] }));
    await vi.waitFor(() => { expect(db.sessions.require('a').state).toBe('lost'); });
    expect(lost).toEqual(['a2', 'a']);
  });

  it('marks the current connection offline on disconnect', async () => {
    await start();
    const node = await connect();
    await node.next('welcome');
    await node.close();
    await vi.waitFor(() => { expect(db.agents.require('alice').status).toBe('offline'); });
  });
});

describe('reliable inbound events', () => {
  it('applies duplicate msgIds once and acknowledges both only after committed effects', async () => {
    const applied: Event[] = [];
    await start({ onEvent: (_agent, event) => {
      db.sessions.update(event.sid, { context_tokens: 123 });
      applied.push(event);
    } });
    const node = await connect();
    await node.next('welcome');
    const event = { type: 'session.compacted', sid: 'a', contextTokensBefore: 1000, contextTokensAfter: 123 } as const;
    const msgId = node.event(event, 'event-one');
    expect((await node.next('ack')).msgId).toBe(msgId);
    expect(db.sessions.require('a').context_tokens).toBe(123);
    expect(db.messages.require(msgId)).toMatchObject({ direction: 'from_node', agent_id: 'alice', session_id: 'a', type: 'session.compacted', acked_at: now });
    node.event(event, msgId);
    expect((await node.next('ack')).msgId).toBe(msgId);
    expect(applied).toEqual([event]);
    expect(db.messages.find({ direction: 'from_node' })).toHaveLength(1);
  });

  it('rolls back a failing event and withholds ack until a successful retry', async () => {
    let fail = true;
    let calls = 0;
    await start({ onEvent: (_agent, event) => {
      calls += 1;
      db.sessions.update(event.sid, { context_tokens: 123 });
      if (fail) throw new Error('handler failed');
    } });
    const node = await connect();
    await node.next('welcome');
    const event = { type: 'session.compacted', sid: 'a', contextTokensBefore: 1000, contextTokensAfter: 123 } as const;
    const msgId = node.event(event, 'retry-event');
    await expect(node.next('ack', (frame) => frame.msgId === msgId, 100)).rejects.toThrow(/Timed out/);
    expect(db.messages.get(msgId)).toBeUndefined();
    expect(db.sessions.require('a').context_tokens).toBe(0);
    fail = false;
    node.event(event, msgId);
    expect((await node.next('ack')).msgId).toBe(msgId);
    expect(db.sessions.require('a').context_tokens).toBe(123);
    expect(calls).toBe(2);
  });

  it('rejects events for another authenticated agent session', async () => {
    let calls = 0;
    await start({ onEvent: () => { calls += 1; } });
    const node = await connect();
    await node.next('welcome');
    const msgId = node.event({ type: 'session.lost', sid: 'b', reason: 'forged' }, 'forged-session');
    expect(await node.waitClosed()).toBe(1008);
    expect(db.messages.get(msgId)).toBeUndefined();
    expect(calls).toBe(0);
    expect(node.frames.some((frame) => frame.kind === 'ack')).toBe(false);
  });

  it('does not accept another agent replaying a processed msgId', async () => {
    await start();
    const alice = await connect();
    await alice.next('welcome');
    alice.event({ type: 'session.lost', sid: 'a', reason: 'test' }, 'unique-id');
    await alice.next('ack');
    const bob = await connect('bob');
    await bob.next('welcome');
    bob.event({ type: 'session.lost', sid: 'b', reason: 'test' }, 'unique-id');
    expect(await bob.waitClosed()).toBe(1008);
    expect(db.messages.require('unique-id').agent_id).toBe('alice');
  });
});

describe('durable command delivery', () => {
  it('resends on connection, records sent/acked timestamps, and ignores foreign acknowledgements', async () => {
    await start();
    const frame = locks.sendToAgent('alice', { type: 'session.open', sid: 'a', profile: 'author' });
    expect(db.messages.require(frame.msgId).sent_at).toBeNull();
    const alice = await connect();
    await alice.next('welcome');
    expect(await alice.next('cmd')).toEqual(frame);
    expect(db.messages.require(frame.msgId).sent_at).toBe(now);
    const bob = await connect('bob');
    await bob.next('welcome');
    bob.ack(frame.msgId);
    bob.heartbeat(status({ humanIdleSec: 1 }));
    await vi.waitFor(() => { expect(db.agents.require('bob').human_idle_sec).toBe(1); });
    expect(db.messages.require(frame.msgId).acked_at).toBeNull();
    now += 1;
    alice.ack(frame.msgId);
    await vi.waitFor(() => { expect(db.messages.require(frame.msgId).acked_at).toBe(now); });
    expect(db.messages.require(frame.msgId).sent_at).toBe(now - 1);
  });

  it('periodically retries an unacked command with its original msgId', async () => {
    await start({}, 1);
    const alice = await connect();
    await alice.next('welcome');
    const command = locks.sendToAgent('alice', { type: 'session.open', sid: 'a', profile: 'author' });
    expect(await alice.next('cmd')).toEqual(command);
    expect(await alice.next('cmd', (frame) => frame.msgId === command.msgId)).toEqual(command);
    alice.ack(command.msgId);
    await vi.waitFor(() => { expect(db.messages.require(command.msgId).acked_at).toBe(now); });
    hub.resendUnacked();
    await expect(alice.next('cmd', (frame) => frame.msgId === command.msgId, 100)).rejects.toThrow(/Timed out/);
  });

  it('reopens a persisted database and redelivers unacked commands after Leader restart', async () => {
    db.close();
    directory = mkdtempSync(join(tmpdir(), 'quorum-hub-'));
    const path = join(directory, 'leader.db');
    db = openDatabase(path);
    seed();
    await start();
    const alice = await connect();
    await alice.next('welcome');
    const command = locks.sendToAgent('alice', { type: 'session.open', sid: 'a', profile: 'author' });
    expect(await alice.next('cmd')).toEqual(command);
    await hub.close();
    await alice.waitClosed();
    db.close();
    db = openDatabase(path);
    now += 5000;
    await start();
    const reconnected = await connect();
    await reconnected.next('welcome');
    expect(await reconnected.next('cmd')).toEqual(command);
    reconnected.ack(command.msgId);
    await vi.waitFor(() => { expect(db.messages.require(command.msgId).acked_at).toBe(now); });
    expect(db.messages.all()).toHaveLength(1);
  });

  it('deduplicates persisted inbound events after Leader restart', async () => {
    db.close();
    directory = mkdtempSync(join(tmpdir(), 'quorum-hub-inbox-'));
    const path = join(directory, 'leader.db');
    db = openDatabase(path);
    seed();
    let calls = 0;
    await start({ onEvent: () => { calls += 1; } });
    const alice = await connect();
    await alice.next('welcome');
    const event = { type: 'session.compacted', sid: 'a', contextTokensBefore: 200, contextTokensAfter: 100 } as const;
    alice.event(event, 'persistent-inbox');
    await alice.next('ack');
    await hub.close();
    await alice.waitClosed();
    db.close();
    db = openDatabase(path);
    await start({ onEvent: () => { calls += 1; } });
    const reconnected = await connect();
    await reconnected.next('welcome');
    reconnected.event(event, 'persistent-inbox');
    expect((await reconnected.next('ack')).msgId).toBe('persistent-inbox');
    expect(calls).toBe(1);
    expect(db.messages.all()).toHaveLength(1);
  });
});
