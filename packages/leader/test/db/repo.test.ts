import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NotFoundError, openDatabase, withTx, type LeaderDb } from '../../src/db/repo.js';

let db: LeaderDb;

function seed() {
  db.agents.insert({ id: 'alice', owner_name: 'Alice', token_hash: 'hash-a', created_at: 1 });
  db.agents.insert({ id: 'bob', owner_name: 'Bob', token_hash: 'hash-b', created_at: 1 });
  db.sessions.insert({ id: 'a', agent_id: 'alice', state: 'idle', created_at: 1, last_used_at: 1 });
  db.sessions.insert({ id: 'b', agent_id: 'bob', state: 'idle', created_at: 1, last_used_at: 1 });
  return db.tasks.insert({ title: 'Feature', description: 'Implement feature', requester_agent_id: 'alice', state: 'QUEUED', created_at: 1, updated_at: 1, state_entered_at: 1 });
}

beforeEach(() => { db = openDatabase(':memory:'); });
afterEach(() => { db.close(); });

describe('schema and migrations', () => {
  it('matches the authoritative SQL verbatim', () => {
    const spec = readFileSync(new URL('../../../../docs/implementation-spec.md', import.meta.url), 'utf8');
    const sql = spec.split('## 7. Data model (Leader SQLite)')[1]?.split('```sql\n')[1]?.split('```')[0];
    expect(readFileSync(new URL('../../src/db/schema.sql', import.meta.url), 'utf8')).toBe(sql);
  });

  it('enables foreign keys and refuses dangling references', () => {
    expect(db.schemaVersion).toBe(1);
    expect(db.foreignKeysEnabled).toBe(true);
    expect(() => db.sessions.insert({ id: 's', agent_id: 'missing', state: 'idle', created_at: 1, last_used_at: 1 })).toThrow(/FOREIGN KEY/);
  });

  it('is idempotent, preserves data, and uses WAL for a file database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'quorum-db-'));
    const filename = join(directory, 'leader.db');
    try {
      const first = openDatabase(filename);
      expect(first.journalMode).toBe('wal');
      first.agents.insert({ id: 'persisted', owner_name: 'Owner', token_hash: 'hash', created_at: 1 });
      first.close();
      const second = openDatabase(filename);
      try {
        expect(second.schemaVersion).toBe(1);
        expect(second.foreignKeysEnabled).toBe(true);
        expect(second.agents.require('persisted').owner_name).toBe('Owner');
        expect(second.integrity).toBe('ok');
      } finally { second.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe('typed repositories', () => {
  it('inserts and reads every table with defaults and stable primary keys', () => {
    const task = seed();
    expect(db.agents.require('alice')).toMatchObject({ status: 'offline', max_sessions: 2, revoked: 0, tags: '[]', cost_ratio_ema: 1 });
    expect(db.sessions.require('a')).toMatchObject({ lock_kind: null, lock_ref: null, files: '[]', task_history: '[]' });
    expect(db.tasks.require(task.id)).toMatchObject({ priority: 1, review_round: 0, paused_from_state: null, files: '[]' });
    const conversation = db.conversations.insert({ id: 'c', task_id: task.id, author_session_id: 'a', author_agent_id: 'alice', reviewer_session_id: 'b', reviewer_agent_id: 'bob', state: 'active', created_at: 1 });
    expect(db.conversations.require('c')).toEqual(conversation);
    const issue = db.issues.insert({ task_id: task.id, code: 'I1', source: 'reviewer', severity: 'blocking', comment: 'Fix it', status: 'open', raised_round: 1, conversation_id: 'c', created_at: 1 });
    expect(db.issues.require(issue.id)).toEqual(issue);
    const message = db.messages.insert({ id: 'm', direction: 'to_node', agent_id: 'bob', session_id: 'b', task_id: task.id, conversation_id: 'c', seq: 1, type: 'review.start', payload: '{"type":"review.start"}', created_at: 1 });
    expect(db.messages.require('m')).toEqual(message);
    const event = db.taskEvents.insert({ task_id: task.id, from_state: 'QUEUED', to_state: 'AUTHORING', reason: 'assigned', actor: 'leader', at: 1 });
    expect(db.taskEvents.require(event.id)).toMatchObject({ ...event, data: '{}' });
    const usage = db.usageLedger.insert({ agent_id: 'bob', session_id: 'b', task_id: task.id, kind: 'lent', role: 'reviewer', input_tokens: 50, output_tokens: 20, estimated: 80, at: 1 });
    expect(db.usageLedger.require(usage.id)).toEqual(usage);
    const directive = db.directives.insert({ id: 'd', requester: 'Alice', agent_id: 'bob', text: 'Explain', state: 'queued', created_at: 1 });
    expect(db.directives.require('d')).toEqual(directive);
    db.mergeQueue.insert({ task_id: task.id, enqueued_at: 1 });
    expect(db.mergeQueue.require(task.id)).toEqual({ task_id: task.id, enqueued_at: 1 });
    expect(db.integrity).toBe('ok');
  });

  it('finds nulls, updates and deletes without exposing SQL', () => {
    seed();
    expect(db.sessions.find({ lock_ref: null }).map((s) => s.id)).toEqual(['a', 'b']);
    expect(db.agents.update('alice', { status: 'online', last_heartbeat_at: 10 }).status).toBe('online');
    expect(db.agents.find({ status: 'online' }).map((a) => a.id)).toEqual(['alice']);
    expect(db.agents.all()).toHaveLength(2);
    expect(db.sessions.delete('a')).toBe(true);
    expect(db.sessions.delete('a')).toBe(false);
    expect(db.sessions.get('a')).toBeUndefined();
    expect(() => db.sessions.update('a', { state: 'lost' })).toThrow(NotFoundError);
  });

  it('rejects malformed JSON, wrong JSON shape, unknown columns and invalid values', () => {
    seed();
    expect(() => db.agents.update('alice', { tags: 'oops' })).toThrow();
    expect(() => db.sessions.update('a', { files: '[1]' })).toThrow(/string array/);
    expect(() => db.sessions.update('a', { task_history: '["1"]' })).toThrow(/integer array/);
    expect(() => db.messages.insert({ id: 'm', direction: 'to_node', agent_id: 'alice', type: 'ping', payload: 'null', created_at: 1 })).toThrow(/JSON object/);
    expect(() => db.agents.update('alice', { max_sessions: Number.NaN })).toThrow(/Invalid/);
    // Runtime checks also protect JavaScript callers and decoded untrusted input.
    expect(() => Reflect.apply(db.agents.update, db.agents, ['alice', { 'status = 1 --': 'online' }])).toThrow(/Unknown/);
    expect(() => Reflect.apply(db.agents.update, db.agents, ['alice', { id: 'changed' }])).toThrow(/immutable/);
  });
});

describe('coordination constraints', () => {
  it('rejects locked sessions without locks and nonlocked sessions with locks', () => {
    seed();
    expect(() => db.sessions.update('a', { state: 'locked' })).toThrow(/CHECK/);
    expect(() => db.sessions.update('a', { lock_kind: 'task', lock_ref: '1' })).toThrow(/CHECK/);
    expect(() => db.sessions.update('a', { state: 'locked', lock_kind: 'task' })).toThrow(/CHECK/);
    db.sessions.update('a', { state: 'locked', lock_kind: 'task', lock_ref: '1', lock_role: 'author' });
    expect(db.sessions.require('a').state).toBe('locked');
  });

  it('rejects self-review and two active conversations, then permits a new pairing after abandonment', () => {
    const task = seed();
    const values = { task_id: task.id, author_session_id: 'a', author_agent_id: 'alice', reviewer_session_id: 'b', reviewer_agent_id: 'bob', state: 'active', created_at: 1 };
    expect(() => db.conversations.insert({ ...values, id: 'self', reviewer_agent_id: 'alice' })).toThrow(/CHECK/);
    db.conversations.insert({ ...values, id: 'c1' });
    expect(() => db.conversations.insert({ ...values, id: 'c2' })).toThrow(/UNIQUE/);
    expect(() => Reflect.apply(db.conversations.update, db.conversations, ['c1', { reviewer_session_id: 'a' }])).toThrow(/immutable/);
    db.conversations.update('c1', { state: 'abandoned', ended_at: 5 });
    db.conversations.insert({ ...values, id: 'c2' });
    expect(db.conversations.find({ task_id: task.id, state: 'active' })).toHaveLength(1);
  });

  it('rejects duplicate issue codes and conversation sequence numbers', () => {
    const task = seed();
    const issue = { task_id: task.id, code: 'I1', source: 'reviewer', severity: 'blocking', comment: 'Fix', status: 'open', raised_round: 1, created_at: 1 };
    db.issues.insert(issue);
    expect(() => db.issues.insert(issue)).toThrow(/UNIQUE/);
    const message = { direction: 'to_node', agent_id: 'alice', conversation_id: 'c', seq: 1, type: 'review.start', payload: '{}', created_at: 1 };
    db.messages.insert({ ...message, id: 'm1' });
    expect(() => db.messages.insert({ ...message, id: 'm2' })).toThrow(/UNIQUE/);
  });
});

describe('transactions', () => {
  it('commits grouped writes and rolls all of them back on failure', () => {
    const task = seed();
    expect(() => withTx(db, () => {
      db.tasks.update(task.id, { state: 'AUTHORING' });
      db.taskEvents.insert({ task_id: task.id, to_state: 'AUTHORING', reason: 'assigned', actor: 'leader', at: 2 });
      throw new Error('abort');
    })).toThrow('abort');
    expect(db.tasks.require(task.id).state).toBe('QUEUED');
    expect(db.taskEvents.all()).toHaveLength(0);
    withTx(db, () => {
      db.tasks.update(task.id, { state: 'AUTHORING' });
      db.taskEvents.insert({ task_id: task.id, to_state: 'AUTHORING', reason: 'assigned', actor: 'leader', at: 2 });
    });
    expect(db.tasks.require(task.id).state).toBe('AUTHORING');
    expect(db.taskEvents.all()).toHaveLength(1);
  });

  it('uses savepoints for nested rollback while allowing the outer transaction to continue', () => {
    seed();
    db.withTx(() => {
      db.agents.update('alice', { status: 'online' });
      expect(() => db.withTx(() => {
        db.agents.update('bob', { status: 'online' });
        throw new Error('nested');
      })).toThrow('nested');
      db.agents.update('alice', { paused: 1 });
    });
    expect(db.agents.require('alice')).toMatchObject({ status: 'online', paused: 1 });
    expect(db.agents.require('bob').status).toBe('offline');
  });

  it('rejects asynchronous transaction callbacks before committing synchronous writes', () => {
    seed();
    expect(() => Reflect.apply(db.withTx, db, [() => {
      db.agents.update('alice', { status: 'online' });
      return Promise.resolve();
    }])).toThrow(/synchronous/);
    expect(db.agents.require('alice').status).toBe('offline');
  });

  it('rejects async functions before invoking them', () => {
    let invoked = false;
    expect(() => Reflect.apply(db.withTx, db, [async () => { invoked = true; }])).toThrow(/synchronous/);
    expect(invoked).toBe(false);
  });
});
