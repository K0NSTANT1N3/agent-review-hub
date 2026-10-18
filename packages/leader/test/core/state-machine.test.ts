import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type LeaderDb, type TaskRow } from '../../src/db/repo.js';
import {
  allowedTransitionIds, enterAuthorState, IllegalTransitionError, TASK_STATES,
  TRANSITIONS, transition, transitionToAuthorState, type TaskState,
} from '../../src/core/state-machine.js';

let db: LeaderDb;
beforeEach(() => {
  db = openDatabase(':memory:');
  db.agents.insert({ id: 'author', owner_name: 'Alice', token_hash: 'hash', status: 'online', created_at: 1 });
});
afterEach(() => { db.close(); });

function task(state: TaskState, patch: Partial<TaskRow> = {}): TaskRow {
  return db.tasks.insert({ title: 'Feature', description: 'Build it', requester_agent_id: 'author',
    state, created_at: 1, updated_at: 1, state_entered_at: 1, ...patch });
}

function attachAuthor(row: TaskRow): TaskRow {
  db.sessions.insert({ id: `s-${row.id}`, agent_id: 'author', state: 'locked', lock_kind: 'task', lock_ref: String(row.id), lock_role: 'author', lease_expires_at: 1000, created_at: 1, last_used_at: 1 });
  return db.tasks.update(row.id, { author_agent_id: 'author', author_session_id: `s-${row.id}` });
}

const options = { reason: 'test', actor: 'leader', at: 123, data: { cause: 'test' } };

// An independent oracle, deliberately not generated from the production transition table.
const expected: Record<TaskState, readonly TaskState[]> = {
  QUEUED: ['AUTHORING', 'PAUSED', 'CANCELLED', 'FAILED'],
  AUTHORING: ['AUTHORING', 'AWAITING_REVIEWER', 'IN_REVIEW', 'ESCALATED', 'PAUSED', 'CANCELLED', 'FAILED'],
  AWAITING_REVIEWER: ['IN_REVIEW', 'AUTHORING', 'MERGE_QUEUED', 'PAUSED', 'CANCELLED', 'FAILED'],
  IN_REVIEW: ['MERGE_QUEUED', 'AUTHORING', 'ESCALATED', 'AWAITING_REVIEWER', 'PAUSED', 'CANCELLED', 'FAILED'],
  MERGE_QUEUED: ['MERGING', 'PAUSED', 'CANCELLED', 'FAILED'],
  MERGING: ['MERGED', 'SYNCING', 'ESCALATED', 'AUTHORING', 'PAUSED', 'CANCELLED', 'FAILED'],
  SYNCING: ['MERGE_QUEUED', 'IN_REVIEW', 'AWAITING_REVIEWER', 'AUTHORING', 'ESCALATED', 'PAUSED', 'CANCELLED', 'FAILED'],
  PAUSED: ['QUEUED', 'AUTHORING', 'AWAITING_REVIEWER', 'IN_REVIEW', 'MERGE_QUEUED', 'MERGING', 'SYNCING', 'ESCALATED', 'PAUSED', 'CANCELLED', 'FAILED'],
  ESCALATED: ['MERGE_QUEUED', 'AUTHORING', 'PAUSED', 'CANCELLED', 'FAILED'],
  MERGED: [], CANCELLED: [], FAILED: [],
};

describe('T1–T33 transition table', () => {
  it('retains every numbered rule, including repeated edges and documented fallbacks', () => {
    expect(TRANSITIONS.map((rule) => rule.id)).toEqual(Array.from({ length: 33 }, (_, i) => `T${i + 1}`));
    expect(allowedTransitionIds({ state: 'AUTHORING', paused_from_state: null }, 'AUTHORING')).toEqual(['T4', 'T12']);
    expect(allowedTransitionIds({ state: 'SYNCING', paused_from_state: null }, 'AWAITING_REVIEWER')).toEqual(['T20']);
    expect(allowedTransitionIds({ state: 'SYNCING', paused_from_state: null }, 'ESCALATED')).toEqual(['T21']);
  });

  for (const from of TASK_STATES) {
    for (const to of TASK_STATES) {
      it(`${from} → ${to}: ${expected[from].includes(to) ? 'allowed' : 'rejected'}`, () => {
        const row = task(from, from === 'PAUSED' ? { paused_from_state: to, pause_reason: 'human' } : {});
        if (expected[from].includes(to)) {
          const changed = transition(db, row.id, to, options);
          expect(changed).toMatchObject({ state: to, updated_at: 123, state_entered_at: 123 });
          expect(db.taskEvents.find({ task_id: row.id })).toEqual([expect.objectContaining({
            task_id: row.id, from_state: from, to_state: to, reason: 'test', actor: 'leader', data: '{"cause":"test"}', at: 123,
          })]);
        } else {
          expect(() => transition(db, row.id, to, options)).toThrow(IllegalTransitionError);
          expect(db.tasks.require(row.id)).toEqual(row);
          expect(db.taskEvents.all()).toEqual([]);
        }
      });
    }
  }
});

describe('pause metadata and dynamic resume', () => {
  it('records human pause and clears both fields on resume', () => {
    const row = task('IN_REVIEW');
    expect(transition(db, row.id, 'PAUSED', { reason: 'human', actor: 'human:Alice', at: 2 }))
      .toMatchObject({ state: 'PAUSED', paused_from_state: 'IN_REVIEW', pause_reason: 'human' });
    expect(transition(db, row.id, 'IN_REVIEW', { reason: 'resumed', actor: 'human:Alice', at: 3 }))
      .toMatchObject({ state: 'IN_REVIEW', paused_from_state: null, pause_reason: null });
    expect(db.taskEvents.find({ task_id: row.id })).toHaveLength(2);
  });

  it('only permits the persisted resume state, plus explicit paused edges', () => {
    const row = task('PAUSED', { paused_from_state: 'AUTHORING', pause_reason: 'author_unavailable' });
    for (const to of ['IN_REVIEW', 'SYNCING', 'MERGING', 'ESCALATED', 'MERGED'] as const) {
      expect(() => transition(db, row.id, to, options)).toThrow(IllegalTransitionError);
    }
    expect(db.taskEvents.all()).toEqual([]);
    expect(transition(db, row.id, 'AUTHORING', options)).toMatchObject({ paused_from_state: null, pause_reason: null });
  });

  for (const invalid of [null, 'PAUSED', 'MERGED', 'CANCELLED', 'FAILED', 'UNKNOWN']) {
    it(`does not resume to an unrelated state when paused_from_state is ${invalid}`, () => {
      const row = task('PAUSED', { paused_from_state: invalid, pause_reason: 'human' });
      expect(() => transition(db, row.id, 'AUTHORING', options)).toThrow(IllegalTransitionError);
      expect(db.tasks.require(row.id)).toEqual(row);
    });
  }

  it('rejects an unknown runtime target even when it matches corrupted pause metadata', () => {
    const row = task('PAUSED', { paused_from_state: 'UNKNOWN', pause_reason: 'human' });
    expect(() => Reflect.apply(transition, undefined, [db, row.id, 'UNKNOWN', options])).toThrow(IllegalTransitionError);
    expect(db.tasks.require(row.id)).toEqual(row);
    expect(db.taskEvents.all()).toEqual([]);
  });

  it('preserves pause metadata on T25 and clears it on reassignment/cancellation/failure', () => {
    const row = task('PAUSED', { paused_from_state: 'SYNCING', pause_reason: 'author_unavailable' });
    expect(transition(db, row.id, 'PAUSED', options)).toMatchObject({ paused_from_state: 'SYNCING', pause_reason: 'author_unavailable' });
    for (const to of ['QUEUED', 'CANCELLED', 'FAILED'] as const) {
      const other = task('PAUSED', { paused_from_state: 'SYNCING', pause_reason: 'author_unavailable' });
      expect(transition(db, other.id, to, options)).toMatchObject({ paused_from_state: null, pause_reason: null });
    }
  });
});

describe('author availability overlay', () => {
  it('enters AUTHORING normally when the correct author session is locked and online', () => {
    const row = attachAuthor(task('IN_REVIEW'));
    expect(transitionToAuthorState(db, row.id, 'AUTHORING', options)).toMatchObject({ state: 'AUTHORING', paused_from_state: null });
    expect(db.taskEvents.all()).toHaveLength(1);
  });

  for (const unavailable of ['offline', 'lost', 'missing', 'revoked', 'wrong-lock'] as const) {
    it(`pauses directly without an intermediate AUTHORING event when author is ${unavailable}`, () => {
      const row = attachAuthor(task('IN_REVIEW'));
      if (unavailable === 'offline') db.agents.update('author', { status: 'offline' });
      if (unavailable === 'revoked') db.agents.update('author', { revoked: 1 });
      if (unavailable === 'lost') db.sessions.update(`s-${row.id}`, { state: 'lost', lock_kind: null, lock_ref: null, lock_role: null });
      if (unavailable === 'missing') db.tasks.update(row.id, { author_session_id: null });
      if (unavailable === 'wrong-lock') db.sessions.update(`s-${row.id}`, { lock_ref: '999' });
      expect(transitionToAuthorState(db, row.id, 'AUTHORING', options))
        .toMatchObject({ state: 'PAUSED', paused_from_state: 'AUTHORING', pause_reason: 'author_unavailable' });
      expect(db.taskEvents.all()).toEqual([expect.objectContaining({ from_state: 'IN_REVIEW', to_state: 'PAUSED' })]);
    });
  }

  it('preserves intended SYNCING on a merge conflict with a missing author', () => {
    const row = task('MERGING');
    expect(transitionToAuthorState(db, row.id, 'SYNCING', options))
      .toMatchObject({ state: 'PAUSED', paused_from_state: 'SYNCING' });
    expect(db.taskEvents.all()).toHaveLength(1);
  });

  it('validates the intended transition before applying the PAUSED overlay', () => {
    const row = task('QUEUED');
    expect(() => transitionToAuthorState(db, row.id, 'SYNCING', options)).toThrow(IllegalTransitionError);
    expect(() => transition(db, row.id, 'PAUSED', { ...options, pause: { from: 'SYNCING', reason: 'author_unavailable' } })).toThrow(IllegalTransitionError);
    expect(db.tasks.require(row.id)).toEqual(row);
    expect(db.taskEvents.all()).toHaveLength(0);
  });

  it('can resume after a session is recreated, and remains paused while still unavailable', () => {
    const row = task('PAUSED', { paused_from_state: 'AUTHORING', pause_reason: 'human' });
    expect(transitionToAuthorState(db, row.id, 'AUTHORING', options))
      .toMatchObject({ state: 'PAUSED', paused_from_state: 'AUTHORING', pause_reason: 'author_unavailable' });
    attachAuthor(db.tasks.require(row.id));
    expect(transitionToAuthorState(db, row.id, 'AUTHORING', { ...options, at: 124 }))
      .toMatchObject({ state: 'AUTHORING', paused_from_state: null, pause_reason: null });
    expect(db.taskEvents.all()).toHaveLength(2);
  });

  it('keeps the availability helper pure', () => {
    const row = attachAuthor(task('IN_REVIEW'));
    const input = { ...row, authorAgent: db.agents.require('author'), authorSession: db.sessions.require(`s-${row.id}`) };
    expect(enterAuthorState(input, 'AUTHORING')).toEqual({ to: 'AUTHORING' });
    expect(enterAuthorState({ ...input, authorAgent: undefined }, 'AUTHORING'))
      .toEqual({ to: 'PAUSED', pause: { from: 'AUTHORING', reason: 'author_unavailable' } });
    expect(db.tasks.require(row.id)).toEqual(row);
    expect(db.taskEvents.all()).toHaveLength(0);
  });
});

describe('atomic audit and caller-owned side effects', () => {
  it('rolls state back when event serialization fails', () => {
    const row = task('QUEUED');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => transition(db, row.id, 'AUTHORING', { ...options, data: cyclic })).toThrow();
    expect(db.tasks.require(row.id)).toEqual(row);
    expect(db.taskEvents.all()).toHaveLength(0);
  });

  it('rolls state and audit back if an outer handler effect fails', () => {
    const row = attachAuthor(task('QUEUED'));
    expect(() => db.withTx(() => {
      transition(db, row.id, 'AUTHORING', options);
      // An invalid lock change simulates a real failing handler side effect.
      db.sessions.update(`s-${row.id}`, { state: 'idle' });
    })).toThrow(/CHECK/);
    expect(db.tasks.require(row.id)).toEqual(row);
    expect(db.taskEvents.all()).toHaveLength(0);
  });

  it('updates only state metadata and audit, leaving commands and locks to the caller', () => {
    const row = attachAuthor(task('QUEUED'));
    const session = db.sessions.require(`s-${row.id}`);
    transition(db, row.id, 'AUTHORING', options);
    expect(db.sessions.require(session.id)).toEqual(session);
    expect(db.messages.all()).toEqual([]);
    expect(db.conversations.all()).toEqual([]);
    expect(db.mergeQueue.all()).toEqual([]);
  });

  it('requires reason, actor, and an integer timestamp', () => {
    const row = task('QUEUED');
    expect(() => transition(db, row.id, 'AUTHORING', { ...options, reason: ' ' })).toThrow(TypeError);
    expect(() => transition(db, row.id, 'AUTHORING', { ...options, actor: '' })).toThrow(TypeError);
    expect(() => transition(db, row.id, 'AUTHORING', { ...options, at: Number.NaN })).toThrow(TypeError);
    expect(db.tasks.require(row.id)).toEqual(row);
    expect(db.taskEvents.all()).toEqual([]);
  });
});
