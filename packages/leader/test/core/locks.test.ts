import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CmdFrameSchema, type AuthorReviseCommand, type AuthorSyncCommand, type CmdFrame, type DirectiveRunCommand, type ReviewStartCommand } from '@quorum/protocol';
import { LockError, LockManager } from '../../src/core/locks.js';
import { openDatabase, type LeaderDb, type TaskRow } from '../../src/db/repo.js';

let db: LeaderDb;
let locks: LockManager;
let now: number;
let task: TaskRow;
let otherTask: TaskRow;
let deliveries: { agentId: string; frame: CmdFrame }[];

function review(sid = 'b', taskId = task.id, conversationId = 'conversation'): ReviewStartCommand {
  return {
    type: 'review.start', sid, taskId, conversationId, round: 1,
    task: { id: taskId, title: 'Feature', description: 'Build feature', tags: [], requester: 'Alice' },
    branch: 'quorum/task-1', baseCommit: 'aaaaaaa', headCommit: 'bbbbbbb', testSummary: 'passed', priorIssues: [], estimated: 100,
  };
}

function revise(sid = 'a', taskId = task.id, conversationId: string | null = 'conversation'): AuthorReviseCommand {
  return {
    type: 'author.revise', sid, taskId, conversationId, round: 1,
    task: { id: taskId, title: 'Feature', description: 'Build feature', tags: [], requester: 'Alice' },
    branch: 'quorum/task-1', openIssues: [], suggestions: [], testFailure: null, estimated: 100,
  };
}

function sync(sid = 'a', taskId = task.id): AuthorSyncCommand {
  return { type: 'author.sync', sid, taskId, branch: 'quorum/task-1', mainBranch: 'main', estimated: 100 };
}

function directive(sid = 'c', directiveId = 'directive'): DirectiveRunCommand {
  return { type: 'directive.run', sid, directiveId, requester: 'Alice', text: 'Explain this code', estimated: 100 };
}

function pair() {
  locks.lockSession('a', 'task', String(task.id), 'author');
  locks.lockSession('b', 'task', String(task.id), 'reviewer');
  return db.conversations.insert({
    id: 'conversation', task_id: task.id, author_session_id: 'a', author_agent_id: 'alice',
    reviewer_session_id: 'b', reviewer_agent_id: 'bob', state: 'active', created_at: now,
  });
}

function expectRejected(action: () => unknown) {
  const messages = db.messages.all();
  const conversations = db.conversations.all();
  const sent = deliveries.length;
  expect(action).toThrow();
  expect(db.messages.all()).toEqual(messages);
  expect(db.conversations.all()).toEqual(conversations);
  expect(deliveries).toHaveLength(sent);
}

beforeEach(() => {
  db = openDatabase(':memory:');
  now = 10_000;
  deliveries = [];
  locks = new LockManager(db, { leaseSec: 30, now: () => now, deliver: (agentId, frame) => { deliveries.push({ agentId, frame }); } });
  for (const [id, owner] of [['alice', 'Alice'], ['bob', 'Bob'], ['charlie', 'Charlie']]) {
    db.agents.insert({ id: id!, owner_name: owner!, token_hash: `hash-${id}`, status: 'online', created_at: now });
  }
  for (const [id, agent] of [['a', 'alice'], ['a2', 'alice'], ['b', 'bob'], ['c', 'charlie']]) {
    db.sessions.insert({ id: id!, agent_id: agent!, state: 'idle', created_at: now, last_used_at: now });
  }
  const values = { title: 'Feature', description: 'Build feature', requester_agent_id: 'alice', author_agent_id: 'alice', state: 'IN_REVIEW', created_at: now, updated_at: now, state_entered_at: now };
  task = db.tasks.insert({ ...values, author_session_id: 'a' });
  otherTask = db.tasks.insert({ ...values, author_session_id: 'a2' });
  db.directives.insert({ id: 'directive', requester: 'Alice', agent_id: 'charlie', session_id: 'c', text: 'Explain', state: 'queued', created_at: now });
});

afterEach(() => { db.close(); });

describe('session locks and leases', () => {
  it('acquires exactly one scoped lock, rejects overwriting it, and releases all lock fields', () => {
    expect(locks.lockSession('a', 'task', String(task.id), 'author')).toMatchObject({
      state: 'locked', lock_kind: 'task', lock_ref: String(task.id), lock_role: 'author', lease_expires_at: 40_000, last_used_at: now,
    });
    expect(() => locks.lockSession('a', 'task', String(otherTask.id), 'author')).toThrow(LockError);
    expect(db.sessions.require('a').lock_ref).toBe(String(task.id));
    now += 1;
    expect(locks.releaseSession('a', 'idle')).toMatchObject({ state: 'idle', lock_kind: null, lock_ref: null, lock_role: null, lease_expires_at: null, last_used_at: now });
    expect(locks.lockSession('a', 'task', String(otherTask.id), 'author').lock_ref).toBe(String(otherTask.id));
  });

  it('can lock a newly opened session, but not a lost or closed session', () => {
    db.sessions.update('a', { state: 'opening' });
    expect(locks.lockSession('a', 'task', String(task.id), 'author').state).toBe('locked');
    locks.releaseSession('a', 'lost');
    expect(() => locks.lockSession('a', 'task', String(task.id), 'author')).toThrow(LockError);
    db.sessions.update('a', { state: 'closed' });
    expect(() => locks.lockSession('a', 'task', String(task.id), 'author')).toThrow(LockError);
    expect(() => locks.releaseSession('a', 'lost')).toThrow(LockError);
  });

  it('rejects nonexistent, terminal, noncanonical, and wrong-author task locks', () => {
    expect(() => locks.lockSession('a', 'task', '999', 'author')).toThrow();
    expect(() => locks.lockSession('a', 'task', `0${task.id}`, 'author')).toThrow(LockError);
    expect(() => locks.lockSession('b', 'task', String(task.id), 'author')).toThrow(LockError);
    expect(() => locks.lockSession('a2', 'task', String(task.id), 'reviewer')).toThrow(LockError);
    expect(() => locks.lockSession('a', 'task', String(task.id), 'directive')).toThrow(LockError);
    db.tasks.update(task.id, { state: 'MERGED' });
    expect(() => locks.lockSession('a', 'task', String(task.id), 'author')).toThrow(LockError);
  });

  it('requires directive role, matching agent and active directive state', () => {
    expect(() => locks.lockSession('a', 'directive', 'directive', 'directive')).toThrow(LockError);
    expect(() => locks.lockSession('c', 'directive', 'directive', 'author')).toThrow(LockError);
    locks.lockSession('c', 'directive', 'directive', 'directive');
    locks.releaseSession('c', 'idle');
    db.directives.update('directive', { state: 'done' });
    expect(() => locks.lockSession('c', 'directive', 'directive', 'directive')).toThrow(LockError);
  });

  it('extends only alive locked sessions belonging to the reporting agent', () => {
    pair();
    locks.lockSession('a2', 'task', String(otherTask.id), 'author');
    now = 20_000;
    locks.extendLease('alice', ['a', 'b', 'c', 'missing']);
    expect(db.sessions.require('a').lease_expires_at).toBe(50_000);
    expect(db.sessions.require('a2').lease_expires_at).toBe(40_000);
    expect(db.sessions.require('b').lease_expires_at).toBe(40_000);
    expect(db.sessions.require('c').lease_expires_at).toBeNull();
    locks.releaseSession('a', 'lost');
    locks.extendLease('alice', ['a']);
    expect(db.sessions.require('a').lease_expires_at).toBeNull();
  });
});

describe('lock-scoped routing', () => {
  it('rejects idle sessions and task A commands routed to a task B lock', () => {
    expectRejected(() => locks.sendToSession('a', sync()));
    locks.lockSession('a', 'task', String(otherTask.id), 'author');
    expectRejected(() => locks.sendToSession('a', sync()));
  });

  it('rejects a command whose embedded sid differs from the target', () => {
    pair();
    expectRejected(() => locks.sendToSession('a', sync('a2')));
  });

  it('rejects wrong command roles and task/directive scope mixing', () => {
    pair();
    locks.lockSession('c', 'directive', 'directive', 'directive');
    expectRejected(() => locks.sendToSession('b', sync('b')));
    expectRejected(() => locks.sendToSession('a', review('a')));
    expectRejected(() => locks.sendToSession('a', directive('a')));
    expectRejected(() => locks.sendToSession('c', sync('c')));
    expectRejected(() => locks.sendToSession('c', directive('c', 'other-directive')));
  });

  it('requires exactly one scope for task.cancel', () => {
    pair();
    expectRejected(() => locks.sendToSession('a', { type: 'task.cancel', sid: 'a' }));
    expectRejected(() => locks.sendToSession('a', { type: 'task.cancel', sid: 'a', taskId: task.id, directiveId: 'directive' }));
    const frame = locks.sendToSession('a', { type: 'task.cancel', sid: 'a', taskId: task.id });
    expect(frame.cmd.type).toBe('task.cancel');
  });

  it('rejects conversation commands to a nonparticipant session', () => {
    pair();
    locks.lockSession('c', 'task', String(task.id), 'reviewer');
    expectRejected(() => locks.sendToSession('c', review('c')));
  });

  it.each(['closed', 'abandoned'])('rejects %s conversation commands', (state) => {
    pair();
    db.conversations.update('conversation', { state });
    expectRejected(() => locks.sendToSession('b', review()));
  });

  it('rejects a conversation for a different task even when the session has that task lock', () => {
    pair();
    locks.releaseSession('b', 'idle');
    locks.lockSession('b', 'task', String(otherTask.id), 'reviewer');
    expectRejected(() => locks.sendToSession('b', review('b', otherTask.id)));
  });

  it('rejects a participant whose stored conversation agent differs from its session agent', () => {
    pair();
    db.conversations.update('conversation', { state: 'abandoned' });
    db.conversations.insert({
      id: 'bad-agent', task_id: task.id, author_session_id: 'a', author_agent_id: 'alice',
      reviewer_session_id: 'b', reviewer_agent_id: 'charlie', state: 'active', created_at: now,
    });
    expectRejected(() => locks.sendToSession('b', review('b', task.id, 'bad-agent')));
  });

  it('prevents self-review when the author changes after the reviewer lock was acquired', () => {
    pair();
    db.tasks.update(task.id, { author_agent_id: 'bob', author_session_id: 'b' });
    expectRejected(() => locks.sendToSession('b', review()));
  });

  it('allows directives only on their matching lock and persists a valid protocol frame', () => {
    locks.lockSession('c', 'directive', 'directive', 'directive');
    const frame = locks.sendToSession('c', directive());
    expect(CmdFrameSchema.parse(frame)).toEqual(frame);
    expect(db.messages.require(frame.msgId)).toMatchObject({ direction: 'to_node', agent_id: 'charlie', session_id: 'c', task_id: null, directive_id: 'directive', conversation_id: null, seq: null, created_at: now, sent_at: null, acked_at: null });
    expect(JSON.parse(db.messages.require(frame.msgId).payload)).toEqual(frame);
    expect(deliveries).toEqual([{ agentId: 'charlie', frame }]);
  });

  it('allocates persisted increasing conversation sequences in both directions', () => {
    pair();
    const frames = [locks.sendToSession('b', review()), locks.sendToSession('a', revise()), locks.sendToSession('b', review())];
    expect(frames.map((frame) => db.messages.require(frame.msgId).seq)).toEqual([1, 2, 3]);
    expect(new Set(frames.map((frame) => frame.msgId)).size).toBe(3);
    expect(db.conversations.require('conversation').next_seq).toBe(4);
    expect(deliveries.map(({ agentId }) => agentId)).toEqual(['bob', 'alice', 'bob']);
    locks = new LockManager(db, { leaseSec: 30, now: () => now, deliver: (agentId, frame) => { deliveries.push({ agentId, frame }); } });
    const next = locks.sendToSession('a', revise());
    expect(db.messages.require(next.msgId).seq).toBe(4);
  });

  it('does not consume conversation sequences for commands without a conversation', () => {
    pair();
    const frame = locks.sendToSession('a', revise('a', task.id, null));
    expect(db.messages.require(frame.msgId)).toMatchObject({ conversation_id: null, seq: null });
    expect(db.conversations.require('conversation').next_seq).toBe(1);
  });
});

describe('transactional outbox delivery', () => {
  it('delivers only after the outer transaction commits all state changes', () => {
    pair();
    locks = new LockManager(db, { leaseSec: 30, now: () => now, deliver: (agentId, frame) => {
      expect(db.tasks.require(task.id).review_round).toBe(2);
      expect(db.messages.require(frame.msgId).direction).toBe('to_node');
      deliveries.push({ agentId, frame });
    } });
    db.withTx(() => {
      locks.sendToSession('b', review());
      expect(deliveries).toHaveLength(0);
      db.tasks.update(task.id, { review_round: 2 });
    });
    expect(deliveries).toHaveLength(1);
  });

  it('rolls back messages, sequences and deferred delivery with the outer transaction', () => {
    pair();
    expect(() => db.withTx(() => {
      locks.sendToSession('b', review());
      locks.sendToSession('a', revise());
      throw new Error('abort');
    })).toThrow('abort');
    expect(db.messages.all()).toHaveLength(0);
    expect(deliveries).toHaveLength(0);
    expect(db.conversations.require('conversation').next_seq).toBe(1);
    const frame = locks.sendToSession('b', review());
    expect(db.messages.require(frame.msgId).seq).toBe(1);
  });

  it('discards rolled-back savepoint delivery and commits the surviving outer delivery', () => {
    pair();
    db.withTx(() => {
      expect(() => db.withTx(() => {
        locks.sendToSession('b', review());
        throw new Error('savepoint');
      })).toThrow('savepoint');
      locks.sendToSession('a', revise());
      expect(deliveries).toHaveLength(0);
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.agentId).toBe('alice');
    expect(db.messages.all()).toHaveLength(1);
    expect(db.messages.all()[0]?.seq).toBe(1);
  });

  it('keeps the unacked durable command when transport delivery fails', () => {
    pair();
    const failures: unknown[] = [];
    locks = new LockManager(db, { leaseSec: 30, now: () => now, deliver: () => { throw new Error('offline'); }, onDeliveryError: (error) => { failures.push(error); } });
    const frame = locks.sendToSession('b', review());
    expect(db.messages.require(frame.msgId)).toMatchObject({ acked_at: null, seq: 1 });
    expect(failures).toHaveLength(1);
    expect(db.conversations.require('conversation').next_seq).toBe(2);
  });
});

describe('agent-scoped lifecycle commands', () => {
  it('opens and closes sessions through the same durable outbox', () => {
    db.sessions.update('c', { state: 'opening' });
    const open = locks.sendToAgent('charlie', { type: 'session.open', sid: 'c', profile: 'directive' });
    db.sessions.update('c', { state: 'closing' });
    const close = locks.sendToAgent('charlie', { type: 'session.close', sid: 'c' });
    expect([open, close].map((frame) => db.messages.require(frame.msgId).type)).toEqual(['session.open', 'session.close']);
    expect(deliveries.map(({ agentId }) => agentId)).toEqual(['charlie', 'charlie']);
  });

  it('does not let lifecycle routing bypass target ownership or a lock', () => {
    pair();
    expectRejected(() => locks.sendToAgent('alice', { type: 'session.close', sid: 'b' }));
    expectRejected(() => locks.sendToAgent('alice', { type: 'session.close', sid: 'a' }));
    expectRejected(() => locks.sendToAgent('charlie', { type: 'session.open', sid: 'c', profile: 'directive' }));
    expectRejected(() => locks.sendToSession('a', { type: 'session.close', sid: 'a' }));
    expectRejected(() => Reflect.apply(locks.sendToAgent, locks, ['alice', sync()]));
  });
});

describe('random lock interleavings', () => {
  it('preserves single locks, scope and immutable distinct-agent pairs across 200 operations', () => {
    pair();
    let seed = 0x13_37_22;
    const random = (max: number) => { seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0; return seed % max; };
    const sids = ['a', 'a2', 'b', 'c'] as const;
    let successfulSends = 0;
    for (let step = 0; step < 200; step += 1) {
      now += random(250);
      const sid = sids[random(sids.length)]!;
      const row = db.sessions.require(sid);
      const target = sid === 'a2' ? otherTask : task;
      const role = sid === 'a' || sid === 'a2' ? 'author' : 'reviewer';
      switch (random(7)) {
        case 0:
          if (row.state === 'locked') expect(() => locks.lockSession(sid, 'task', String(target.id), role)).toThrow(LockError);
          else locks.lockSession(sid, 'task', String(target.id), role);
          break;
        case 1:
          if (row.state === 'locked') locks.releaseSession(sid, 'idle');
          else expect(() => locks.releaseSession(sid, 'idle')).toThrow(LockError);
          break;
        case 2: {
          const command = role === 'author' ? revise(sid, target.id, sid === 'a' ? 'conversation' : null) : review(sid);
          if (row.state !== 'locked' || sid === 'c') expectRejected(() => locks.sendToSession(sid, command));
          else { locks.sendToSession(sid, command); successfulSends += 1; }
          break;
        }
        case 3:
          expectRejected(() => locks.sendToSession(sid, { type: 'task.cancel', sid, taskId: target.id === task.id ? otherTask.id : task.id }));
          break;
        case 4: {
          const otherAgentLease = db.sessions.require('b').lease_expires_at;
          locks.extendLease('alice', ['a', 'a2', 'b']);
          expect(db.sessions.require('b').lease_expires_at).toBe(otherAgentLease);
          break;
        }
        case 5:
          if (row.state === 'locked') {
            const count = db.messages.all().length;
            const sent = deliveries.length;
            expect(() => db.withTx(() => { locks.sendToSession(sid, { type: 'task.cancel', sid, taskId: target.id }); throw new Error('rollback'); })).toThrow('rollback');
            expect(db.messages.all()).toHaveLength(count);
            expect(deliveries).toHaveLength(sent);
          }
          break;
        case 6:
          expect(() => Reflect.apply(db.conversations.update, db.conversations, ['conversation', { reviewer_session_id: 'c' }])).toThrow(/immutable/);
          break;
      }
      for (const session of db.sessions.all()) {
        expect(session.state === 'locked').toBe(session.lock_kind !== null);
        expect(session.lock_kind === null).toBe(session.lock_ref === null);
        expect(session.state === 'locked').toBe(session.lease_expires_at !== null);
      }
      const conversation = db.conversations.require('conversation');
      expect(conversation).toMatchObject({ author_session_id: 'a', reviewer_session_id: 'b', author_agent_id: 'alice', reviewer_agent_id: 'bob', task_id: task.id });
      expect(conversation.reviewer_agent_id).not.toBe(db.tasks.require(task.id).author_agent_id);
      const sequenced = db.messages.find({ conversation_id: 'conversation' }).map((message) => message.seq).sort((a, b) => a! - b!);
      expect(sequenced).toEqual(Array.from({ length: sequenced.length }, (_, index) => index + 1));
      expect(conversation.next_seq).toBe(sequenced.length + 1);
    }
    expect(successfulSends).toBeGreaterThan(5);
    expect(deliveries).toHaveLength(successfulSends);
    for (const { agentId, frame } of deliveries) {
      const row = db.messages.require(frame.msgId);
      expect(row.agent_id).toBe(agentId);
      expect(row.session_id).toBe(frame.cmd.sid);
      if ('taskId' in frame.cmd) expect(row.task_id).toBe(frame.cmd.taskId);
      if (row.conversation_id !== null) expect(['a', 'b']).toContain(frame.cmd.sid);
    }
    expect(db.integrity).toBe('ok');
  });
});
