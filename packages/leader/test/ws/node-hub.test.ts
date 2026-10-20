import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseLeaderConfig, type Event, type HelloFrame, type NodeStatus, type SessionReport, type TranscriptAppended, type TranscriptFrame } from '@quorum/protocol';
import { mintApiToken } from '../../src/core/api-tokens.js';
import { silentLogger } from '../../src/logging.js';
import { LockManager } from '../../src/core/locks.js';
import { openDatabase, type LeaderDb, type SessionRow } from '../../src/db/repo.js';
import { NodeHub, POISON_EVENT_ATTEMPTS, type HubOptions } from '../../src/ws/node-hub.js';
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

async function start(options: Partial<HubOptions> = {}, resendUnackedSec = 10, transcriptMaxBytesPerTask?: number) {
  locks = new LockManager(db, { leaseSec: 120, now: () => now, deliver: (agentId, frame) => { hub.deliver(agentId, frame); } });
  const config = parseLeaderConfig({
    listen: { host: '127.0.0.1', port: 0 }, dbPath: ':memory:',
    repo: { remoteUrl: 'file:///unused', mainBranch: 'main' }, timeouts: { resendUnackedSec },
  });
  hub = new NodeHub(db, { ...config, ...(transcriptMaxBytesPerTask === undefined ? {} : { transcriptMaxBytesPerTask }) }, { locks, now: () => now, ...options });
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
    expect(await node.next('welcome')).toEqual({ kind: 'welcome', serverTime: now, heartbeatIntervalSec: 10, resendUnackedSec: 10, turnTimeoutSec: 1800, mainBranch: 'main', capabilities: ['transcript-v1'] });
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

describe('poison-message protection', () => {
  it('acks and records events for unknown sessions instead of disconnecting', async () => {
    await start();
    const node = await connect();
    await node.next('welcome');
    const id = node.event({ type: 'session.lost', sid: 'ghost', reason: 'gone' });
    await node.next('ack', (f) => f.msgId === id);
    expect(db.messages.get(id)).toMatchObject({ direction: 'from_node', session_id: 'ghost', type: 'session.lost' });
    expect(node.socket.readyState).toBe(1);
  });

  it('still closes on a real ownership mismatch', async () => {
    await start();
    const node = await connect('alice');
    await node.next('welcome');
    node.event({ type: 'session.lost', sid: 'b', reason: 'not mine' });
    expect(await node.waitClosed()).toBe(1008);
  });

  it('acks an event after POISON_EVENT_ATTEMPTS failing handler runs, without retrying forever', async () => {
    let calls = 0;
    await start({ onEvent: () => { calls += 1; throw new Error('handler bug'); } });
    const node = await connect();
    await node.next('welcome');
    const evt: Event = { type: 'session.lost', sid: 'a', reason: 'x' };
    const id = 'poison-1';
    for (let i = 0; i < POISON_EVENT_ATTEMPTS; i += 1) node.event(evt, id);
    await node.next('ack', (f) => f.msgId === id);
    expect(calls).toBe(POISON_EVENT_ATTEMPTS);
    expect(db.messages.get(id)).toMatchObject({ direction: 'from_node' });
    node.event(evt, id);
    await node.next('ack', (f) => f.msgId === id);
    expect(calls).toBe(POISON_EVENT_ATTEMPTS);
  });
});

describe('transcript ingest', () => {
  function frame(taskId: number, msgId = 'transcript-1', seq = 1): TranscriptFrame {
    return { kind: 'transcript', msgId, taskId, sid: 'a', events: [{ seq, at: now, kind: 'text', mode: 'final', text: 'done' }] };
  }

  async function setup(options: Partial<HubOptions> = {}, cap?: number) {
    await start(options, 10, cap);
    db.sessions.update('a', { profile: 'author' });
    const task = lockAuthor();
    const node = await connect('alice', { sessions: [report('a')] });
    await node.next('welcome');
    return { task, node };
  }

  it('stores events separately from the state machine and deduplicates msgId and overlapping seq batches', async () => {
    const appended: TranscriptAppended[] = [];
    const onEvent = vi.fn();
    const { task, node } = await setup({ onEvent, onTranscript: (batch) => { appended.push(batch); } });
    const first = frame(task.id);
    node.send(first);
    await node.next('ack');
    expect(db.taskTranscript(task.id)[0]).toEqual({ sid: 'a', agentId: 'alice', profile: 'author', events: first.events });
    expect(db.messages.all()).toEqual([]);
    expect(onEvent).not.toHaveBeenCalled();
    node.send({ ...first, events: [{ ...first.events[0]!, text: 'changed', kind: 'text', mode: 'final' }] });
    await node.next('ack');
    node.send({ ...frame(task.id, 'transcript-2', 2), events: [...first.events, ...frame(task.id, 'unused', 2).events] });
    await node.next('ack');
    node.send(frame(task.id, 'transcript-3', 1));
    await node.next('ack');
    expect(db.taskTranscript(task.id)[0]!.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(appended.map((batch) => batch.events.map((e) => e.seq))).toEqual([[1], [2]]);
    expect(db.transcriptReceipts.all()).toHaveLength(3);
  });

  it('accepts a maximum-size text batch beyond the old 1 MiB WebSocket limit', async () => {
    const { task, node } = await setup();
    const events = Array.from({ length: 100 }, (_, index) => ({ seq: index + 1, at: now, kind: 'text' as const, mode: 'final' as const, text: '界'.repeat(16384) }));
    node.send({ ...frame(task.id), events });
    await node.next('ack');
    expect(db.taskTranscript(task.id)[0]!.events).toHaveLength(100);
    expect(db.transcriptBytes(task.id)).toBeGreaterThan(1024 * 1024);
  });

  it('drops and logs unknown, foreign, unassigned, older-task and missing-profile sessions, ACKing to stop replay', async () => {
    const warn = vi.fn();
    const { task, node } = await setup({ logger: { ...silentLogger, warn } });
    const other = db.tasks.insert({ title: 'other', description: 'd', requester_agent_id: 'alice', state: 'QUEUED', created_at: now, updated_at: now, state_entered_at: now });
    db.sessions.update('a', { task_history: JSON.stringify([other.id, task.id]) });
    for (const [index, patch] of [{ sid: 'ghost' }, { sid: 'b' }, { sid: 'a2' }, { taskId: other.id }, { taskId: 999 }].entries()) {
      const invalid = { ...frame(task.id, `drop-${index}`), ...patch };
      node.send(invalid);
      await node.next('ack', (ack) => ack.msgId === invalid.msgId);
    }
    db.sessions.update('a', { profile: null });
    node.send(frame(task.id, 'missing-profile'));
    await node.next('ack');
    expect(warn).toHaveBeenCalledTimes(6);
    expect(db.transcriptEvents.all()).toEqual([]);
    expect(node.socket.readyState).toBe(1);
  });

  it('accepts trailing events only for the last task after release, rejecting older history after reuse', async () => {
    const { task, node } = await setup();
    locks.releaseSession('a', 'idle');
    const older = db.tasks.insert({ title: 'old', description: 'd', requester_agent_id: 'alice', state: 'QUEUED', created_at: 1, updated_at: 1, state_entered_at: 1 });
    db.sessions.update('a', { task_history: JSON.stringify([older.id, task.id]) });
    node.send(frame(task.id));
    await node.next('ack');
    node.send(frame(older.id, 'older', 2));
    await node.next('ack');
    expect(db.taskTranscript(task.id)[0]!.events).toHaveLength(1);
    expect(db.taskTranscript(older.id)).toEqual([]);
  });

  it('uses the last turn command for released sessions, including a later directive invalidating old task history', async () => {
    const { task, node } = await setup();
    locks.releaseSession('a', 'idle');
    const command = { id: 'last-turn', direction: 'to_node', agent_id: 'alice', session_id: 'a', task_id: task.id, type: 'author.start', payload: '{}', created_at: now, acked_at: now };
    db.messages.insert(command);
    node.send(frame(task.id));
    await node.next('ack');
    db.sessions.update('a', { task_history: JSON.stringify([task.id]) });
    db.messages.insert({ ...command, id: 'directive-turn', task_id: null, type: 'directive.run' });
    node.send(frame(task.id, 'after-directive', 2));
    await node.next('ack');
    expect(db.taskTranscript(task.id)[0]!.events.map((e) => e.seq)).toEqual([1]);
  });

  it('retries a failed transaction without affecting subsequent state machine events', async () => {
    const onEvent = vi.fn();
    const { task, node } = await setup({ onEvent });
    const append = vi.spyOn(db, 'appendTranscript').mockImplementationOnce(() => { throw new Error('storage failed'); });
    const first = frame(task.id);
    node.send(first);
    node.send(frame(task.id, 'later-batch', 2));
    node.event({ type: 'session.compacted', sid: 'a', contextTokensBefore: 200, contextTokensAfter: 100 }, 'state-event');
    await node.next('ack', (ack) => ack.msgId === 'state-event');
    await vi.waitFor(() => expect(append).toHaveBeenCalledOnce());
    expect(onEvent).toHaveBeenCalledOnce();
    expect(db.transcriptReceipts.get(first.msgId)).toBeUndefined();
    expect(db.sessions.require('a').transcript_seq).toBe(0);
    expect(db.transcriptReceipts.get('later-batch')).toBeUndefined();
    node.send(first);
    await node.next('ack', (ack) => ack.msgId === first.msgId);
    expect(db.taskTranscript(task.id)[0]!.events).toHaveLength(1);
    node.send(frame(task.id, 'later-batch', 2));
    await node.next('ack', (ack) => ack.msgId === 'later-batch');
    expect(db.taskTranscript(task.id)[0]!.events.map((event) => event.seq)).toEqual([1, 2]);
  });

  it('bounds transcript backlog and replays overflow in sequence while state events keep flowing', async () => {
    const onEvent = vi.fn();
    const { task, node } = await setup({ onEvent });
    for (let seq = 1; seq <= 100; seq++) node.send(frame(task.id, `burst-${seq}`, seq));
    node.event({ type: 'session.compacted', sid: 'a', contextTokensBefore: 200, contextTokensAfter: 100 }, 'burst-state');
    await node.next('ack', (ack) => ack.msgId === 'burst-state');
    await vi.waitFor(() => expect(db.transcriptReceipts.get('burst-32')).toBeDefined());
    expect(onEvent).toHaveBeenCalledOnce();
    expect(db.transcriptReceipts.all().length).toBeLessThan(100);
    for (let seq = 1; seq <= 100; seq++) {
      if (db.transcriptReceipts.get(`burst-${seq}`) !== undefined) continue;
      node.send(frame(task.id, `burst-${seq}`, seq));
      await node.next('ack', (ack) => ack.msgId === `burst-${seq}`);
    }
    expect(db.taskTranscript(task.id)[0]!.events.map((event) => event.seq)).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));
  });

  it('does not roll back or withhold ACK when the UI notification fails', async () => {
    const { task, node } = await setup({ onTranscript: () => { throw new Error('subscriber failed'); } });
    node.send(frame(task.id));
    await node.next('ack');
    expect(db.taskTranscript(task.id)[0]!.events).toHaveLength(1);
  });

  it('pushes retained tool output and preserves sequence dedupe after pruning', async () => {
    const appended: TranscriptAppended[] = [];
    const { task, node } = await setup({ onTranscript: (batch) => { appended.push(batch); } }, 130);
    const first = { ...frame(task.id), events: [{ seq: 1, at: now, kind: 'tool_result', id: 'tool', ok: true, output: '界'.repeat(1000) }] } as const;
    node.send({ ...first, events: [...first.events] });
    await node.next('ack');
    expect(appended[0]!.events[0]).toMatchObject({ output: '' });
    node.send(frame(task.id, 'new', 2));
    await node.next('ack');
    node.send({ ...first, msgId: 'pruned-replay', events: [...first.events] });
    await node.next('ack');
    expect(db.taskTranscript(task.id)[0]!.events.map((e) => e.seq)).toEqual([2]);
    expect(appended).toHaveLength(2);
  });

  it('persists transcript receipts and seq watermarks across restart', async () => {
    db.close();
    directory = mkdtempSync(join(tmpdir(), 'quorum-transcript-restart-'));
    const path = join(directory, 'leader.db');
    db = openDatabase(path);
    seed();
    const { task, node } = await setup();
    const first = frame(task.id);
    node.send(first);
    await node.next('ack');
    await hub.close();
    await node.waitClosed();
    db.close();
    db = openDatabase(path);
    const onTranscript = vi.fn();
    await start({ onTranscript });
    const reconnected = await connect('alice', { sessions: [report('a')] });
    await reconnected.next('welcome');
    for (const msgId of [first.msgId, 'new-msgId-same-seq']) {
      reconnected.send({ ...first, msgId });
      await reconnected.next('ack', (ack) => ack.msgId === msgId);
    }
    expect(db.taskTranscript(task.id)[0]!.events).toEqual(first.events);
    expect(onTranscript).not.toHaveBeenCalled();
    expect(db.sessions.require('a').transcript_seq).toBe(1);
  });

  it('rejects msgId collisions across agents and between transcript and evt frames', async () => {
    const { task, node } = await setup();
    node.send(frame(task.id));
    await node.next('ack');
    const bob = await connect('bob');
    await bob.next('welcome');
    bob.send(frame(task.id));
    expect(await bob.waitClosed()).toBe(1008);
    node.event({ type: 'session.compacted', sid: 'a', contextTokensBefore: 200, contextTokensAfter: 100 }, 'transcript-1');
    expect(await node.waitClosed()).toBe(1008);
  });

  it.each(['requester', 'owner'] as const)('rejects a %s API token as a Node credential', async (scope) => {
    await start();
    const { token } = mintApiToken(db, 'alice', '', now, scope);
    const node = await connect('alice', { token });
    expect((await node.next('reject')).reason).toBe('bad_token');
    expect(await node.waitClosed()).toBe(1008);
  });

  it('stores hello and heartbeat adapter metadata and clears absent metadata to unknown', async () => {
    await start();
    const detectedAgents = [{ type: 'codex', version: '1.0', trust: 'sandboxed' }] as const;
    const node = await connect('alice', { trust: 'low', detectedAgents: [...detectedAgents] });
    await node.next('welcome');
    expect(db.agents.require('alice')).toMatchObject({ trust: 'low', detected_agents: JSON.stringify(detectedAgents) });
    node.heartbeat(status({ trust: 'enforced', detectedAgents: [] }));
    await vi.waitFor(() => expect(db.agents.require('alice').trust).toBe('enforced'));
    expect(db.agents.require('alice').detected_agents).toBe('[]');
    node.heartbeat(status());
    await vi.waitFor(() => expect(db.agents.require('alice').trust).toBeNull());
    expect(db.agents.require('alice').detected_agents).toBeNull();
  });
});
