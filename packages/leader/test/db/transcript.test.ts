import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '@quorum/protocol';
import { openDatabase, type LeaderDb } from '../../src/db/repo.js';
import { DEFAULT_TRANSCRIPT_MAX_BYTES_PER_TASK, LeaderRuntimeConfigSchema } from '../../src/config.js';

let db: LeaderDb;
let taskId: number;
const final = (seq: number, text = 'done'): AgentEvent => ({ seq, at: seq, kind: 'text', mode: 'final', text, messageId: 'reply' });
const thinking = (seq: number): AgentEvent => ({ seq, at: seq, kind: 'thinking', text: 'thinking'.repeat(100) });
const tool = (seq: number): AgentEvent => ({ seq, at: seq, kind: 'tool_result', id: `tool-${seq}`, ok: true, output: '界'.repeat(1000) });
const append = (events: AgentEvent[], turn = 't1', cap = 8 * 1024 * 1024, sid = 'a') => db.appendTranscript(taskId, sid, 'alice', 'author', events, turn, cap);

beforeEach(() => {
  db = openDatabase(':memory:');
  db.agents.insert({ id: 'alice', owner_name: 'Alice', token_hash: 'hash', created_at: 1 });
  for (const id of ['a', 'b']) db.sessions.insert({ id, agent_id: 'alice', state: 'idle', profile: 'author', created_at: 1, last_used_at: 1 });
  taskId = db.tasks.insert({ title: 't', description: 'd', requester_agent_id: 'alice', state: 'QUEUED', created_at: 1, updated_at: 1, state_entered_at: 1 }).id;
});
afterEach(() => db.close());

describe('transcript retention', () => {
  it('uses a configurable positive byte cap with an 8 MiB default', () => {
    const config = { repo: { remoteUrl: 'file:///unused' } };
    expect(LeaderRuntimeConfigSchema.parse(config).transcriptMaxBytesPerTask).toBe(DEFAULT_TRANSCRIPT_MAX_BYTES_PER_TASK);
    expect(LeaderRuntimeConfigSchema.parse({ ...config, transcriptMaxBytesPerTask: 123 }).transcriptMaxBytesPerTask).toBe(123);
    for (const value of [0, -1, 1.5, '123']) expect(() => LeaderRuntimeConfigSchema.parse({ ...config, transcriptMaxBytesPerTask: value })).toThrow();
  });

  it('orders events by seq with exclusive per-session cursors and keeps empty session pages', () => {
    append([thinking(1), final(3)]);
    append([final(1)], 't2', undefined, 'b');
    expect(db.taskTranscript(taskId).map((s) => [s.sid, s.agentId, s.profile, s.events.map((e) => e.seq)]))
      .toEqual([['a', 'alice', 'author', [1, 3]], ['b', 'alice', 'author', [1]]]);
    expect(db.taskTranscript(taskId, 1, 'a')[0]!.events).toEqual([final(3)]);
    expect(db.taskTranscript(taskId, 3, 'a')[0]!.events).toEqual([]);
    expect(db.taskTranscript(taskId, 0, 'unknown')).toEqual([]);
  });

  it('blanks tool outputs before deleting thinking or other events, counting UTF-8 bytes', () => {
    const events = [tool(1), thinking(2), final(3)];
    append(events);
    const bytes = db.transcriptBytes(taskId);
    expect(bytes).toBe(events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0));
    append([final(4)], 't1', bytes - 100);
    const stored = db.taskTranscript(taskId)[0]!.events;
    expect(stored).toEqual([{ ...tool(1), output: '' }, thinking(2), final(3), final(4)]);
    expect(db.transcriptBytes(taskId)).toBeLessThanOrEqual(bytes - 100);
  });

  it('blanks oldest tool outputs first, stopping once below the cap', () => {
    append([tool(1), tool(2)]);
    const bytes = db.transcriptBytes(taskId);
    append([final(3)], 't1', bytes - 100);
    expect(db.taskTranscript(taskId)[0]!.events).toEqual([{ ...tool(1), output: '' }, tool(2), final(3)]);
  });

  it('deletes thinking before older events, then oldest events, preserving all latest final chunks', () => {
    append([final(1, 'old'), thinking(2)]);
    const cap = Buffer.byteLength(JSON.stringify(final(1, 'old'))) + Buffer.byteLength(JSON.stringify(final(3)));
    append([final(3)], 't2', cap);
    expect(db.taskTranscript(taskId)[0]!.events).toEqual([final(1, 'old'), final(3)]);
    append([final(4)], 't2', 1);
    expect(db.taskTranscript(taskId)[0]!.events).toEqual([final(3), final(4)]);
    expect(db.transcriptBytes(taskId)).toBeGreaterThan(1);
  });

  it('preserves latest finals for every session and never resurrects pruned replay events', () => {
    append([final(1)], 'a1');
    append([final(1)], 'b1', 1, 'b');
    append([thinking(2)], 'a2', 1);
    expect(db.taskTranscript(taskId).map((s) => s.events)).toEqual([[], [final(1)]]);
    expect(append([final(1), thinking(2)], 'a1')).toEqual([]);
    expect(db.sessions.require('a').transcript_seq).toBe(2);
    expect(append([thinking(2), final(3)], 'a3')).toEqual([final(3)]);
  });

  it('enforces unique sid/seq across tasks and rolls back failed appends including watermarks', () => {
    append([final(1)]);
    const row = db.transcriptEvents.all()[0]!;
    const { id: _id, ...values } = row;
    expect(() => db.transcriptEvents.insert(values)).toThrow(/UNIQUE.*sid.*seq/);
    expect(() => db.withTx(() => { append([final(2)]); throw new Error('abort'); })).toThrow('abort');
    expect(db.sessions.require('a').transcript_seq).toBe(1);
    expect(db.taskTranscript(taskId)[0]!.events).toEqual([final(1)]);
  });
});
