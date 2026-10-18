import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseLeaderConfig, type AuthorSubmittedEvent, type AuthorSyncedEvent, type CmdFrame,
  type Event, type LeaderConfig, type ReviewCompletedEvent, type ReviewOutput, type TurnFailedEvent,
} from '@quorum/protocol';
import { EventHandlers } from '../../src/core/handlers.js';
import { LockManager } from '../../src/core/locks.js';
import { transition } from '../../src/core/state-machine.js';
import { openDatabase, type LeaderDb, type TaskRow } from '../../src/db/repo.js';
import { NodeHub } from '../../src/ws/node-hub.js';
import { FakeNode } from '../helpers/fake-node.js';

let db: LeaderDb;
let locks: LockManager;
let handlers: EventHandlers;
let config: LeaderConfig;
let task: TaskRow;
let now: number;
let commands: CmdFrame[];
let attention: { taskId: number; reason: string; message: string }[];

const usage = { inputTokens: 80, outputTokens: 20, contextTokens: 1000 };
const passed = { passed: true, exitCode: 0, outputTail: 'tests passed', durationMs: 10, timedOut: false };
const failed = { ...passed, passed: false, exitCode: 1, outputTail: 'Expected true, got false' };

function latest(sid: string): CmdFrame {
  const frame = commands.filter((command) => command.cmd.sid === sid).at(-1);
  if (frame === undefined) throw new Error(`No command for ${sid}`);
  return frame;
}

function author(kind: 'start' | 'revise' | 'sync' = 'start') {
  return handlers.sendAuthor(task.id, kind);
}

function pair() {
  db.tasks.update(task.id, { state: 'IN_REVIEW' });
  locks.lockSession('b', 'task', String(task.id), 'reviewer');
  db.conversations.insert({ id: 'conversation', task_id: task.id, author_agent_id: 'alice', author_session_id: 'a', reviewer_agent_id: 'bob', reviewer_session_id: 'b', state: 'active', created_at: now });
  return handlers.sendReview(task.id, 'conversation', 'start');
}

function submitted(patch: Partial<AuthorSubmittedEvent> = {}): AuthorSubmittedEvent {
  return {
    type: 'author.submitted', sid: 'a', taskId: task.id, inReplyTo: latest('a').msgId,
    status: 'done', summary: 'Implemented feature', responses: [], headCommit: 'ccccccc', baseCommit: 'aaaaaaa',
    filesChanged: ['src/feature.ts'], diffLines: 12, tests: passed, usage, ...patch,
  };
}

function synced(patch: Partial<AuthorSyncedEvent> = {}): AuthorSyncedEvent {
  return { type: 'author.synced', sid: 'a', taskId: task.id, inReplyTo: latest('a').msgId, headCommit: 'ddddddd', hadConflicts: false, tests: passed, usage, ...patch };
}

function reviewed(output: Partial<ReviewOutput> = {}, patch: Partial<ReviewCompletedEvent> = {}): ReviewCompletedEvent {
  return {
    type: 'review.completed', sid: 'b', taskId: task.id, conversationId: 'conversation', inReplyTo: latest(patch.sid ?? 'b').msgId,
    reviewedCommit: db.tasks.require(task.id).head_commit!, usage,
    output: { verdict: 'approve', summary: 'Reviewed', previousIssues: [], newIssues: [], ...output }, ...patch,
  };
}

function failure(sid: string, code: TurnFailedEvent['code'], patch: Partial<TurnFailedEvent> = {}): TurnFailedEvent {
  return { type: 'turn.failed', sid, taskId: task.id, inReplyTo: latest(sid).msgId, code, message: 'Turn failed', ...patch };
}

function issue(code = 'I1', patch: Partial<Parameters<typeof db.issues.insert>[0]> = {}) {
  return db.issues.insert({ task_id: task.id, code, source: 'reviewer', severity: 'blocking', comment: 'Fix this edge case', status: 'open', raised_round: 1, created_at: now, ...patch });
}

function deliver(event: Event, agentId = 'alice') { handlers.handle(agentId, event); }

beforeEach(() => {
  db = openDatabase(':memory:');
  now = 100_000;
  commands = [];
  attention = [];
  config = parseLeaderConfig({
    repo: { remoteUrl: 'file:///unused' }, limits: { maxReviewRounds: 3, maxTestFixAttempts: 2, maxTurnRetries: 1, maxDisputesPerIssue: 2 },
    costEstimate: { baseTokens: 100, perDiffLine: 0, perChangedFile: 0, authorTaskTokens: 100, emaAlpha: 0.2 },
  });
  for (const [id, owner] of [['alice', 'Alice'], ['bob', 'Bob'], ['carol', 'Alice']] as const) {
    db.agents.insert({ id, owner_name: owner, token_hash: `hash-${id}`, status: 'online', last_heartbeat_at: now, created_at: now });
  }
  for (const [id, agent] of [['a', 'alice'], ['a2', 'alice'], ['b', 'bob'], ['c', 'carol']] as const) {
    db.sessions.insert({ id, agent_id: agent, state: 'idle', created_at: now, last_used_at: now });
  }
  task = db.tasks.insert({
    title: 'Feature', description: 'Build the feature', requester_agent_id: 'alice', author_agent_id: 'alice', author_session_id: 'a',
    state: 'AUTHORING', branch: 'quorum/task-1', base_commit: 'aaaaaaa', head_commit: 'bbbbbbb',
    created_at: now, updated_at: now, state_entered_at: now,
  });
  locks = new LockManager(db, { leaseSec: 120, now: () => now, deliver: (_agentId, frame) => { commands.push(frame); } });
  locks.lockSession('a', 'task', String(task.id), 'author');
  handlers = new EventHandlers(db, config, locks, {
    now: () => now, onAttention: (taskId, reason, message) => { attention.push({ taskId, reason, message }); },
  });
});

afterEach(() => { db.close(); });

describe('author submissions', () => {
  it('stores the submitted diff and usage, resets retry counters, and awaits a reviewer', () => {
    author();
    db.tasks.update(task.id, { test_fix_attempts: 2, turn_retries: 1 });
    deliver(submitted());
    expect(db.tasks.require(task.id)).toMatchObject({ state: 'AWAITING_REVIEWER', head_commit: 'ccccccc', base_commit: 'aaaaaaa', files: '["src/feature.ts"]', diff_lines: 12, test_fix_attempts: 0, turn_retries: 0 });
    expect(db.usageLedger.all()).toHaveLength(1);
    expect(db.usageLedger.all()[0]).toMatchObject({ agent_id: 'alice', task_id: task.id, session_id: 'a', kind: 'own', role: 'author', input_tokens: 80, output_tokens: 20, estimated: 100 });
    expect(db.sessions.require('a').context_tokens).toBe(1000);
    expect(db.taskEvents.all()).toHaveLength(1);
    expect(commands).toHaveLength(1);
  });

  it('creates system blocking issues and retries failed tests, then escalates when exhausted', () => {
    author();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      deliver(submitted({ tests: failed }));
      const current = db.tasks.require(task.id);
      if (attempt < 3) {
        expect(current).toMatchObject({ state: 'AUTHORING', test_fix_attempts: attempt });
        expect(latest('a').cmd).toMatchObject({ type: 'author.revise', testFailure: failed.outputTail });
        expect(db.issues.find({ task_id: task.id, source: 'system', status: 'open' }).length).toBeGreaterThan(0);
      } else expect(current).toMatchObject({ state: 'ESCALATED', escalation_reason: 'tests_failing' });
    }
    expect(attention.at(-1)?.message).toContain('tests_failing');
  });

  it('resolves system test failures on a later passing author result before the first review', () => {
    author();
    deliver(submitted({ tests: failed }));
    const system = db.issues.find({ task_id: task.id, source: 'system', status: 'open' });
    expect(system.length).toBeGreaterThan(0);
    expect(latest('a').cmd).toMatchObject({ type: 'author.revise', openIssues: expect.arrayContaining([expect.objectContaining({ source: 'system', severity: 'blocking' })]) });
    deliver(submitted({ tests: passed }));
    for (const row of system) expect(db.issues.require(row.id).status).toBe('resolved');
    expect(db.tasks.require(task.id).state).toBe('AWAITING_REVIEWER');
    const review = pair();
    expect(review.cmd).toMatchObject({ type: 'review.start', priorIssues: [] });
  });

  it('escalates a blocked author and permits a human answer to be included in the next revision', () => {
    author();
    deliver(submitted({ status: 'blocked', blockedReason: 'Which database should be used?' }));
    expect(db.tasks.require(task.id).state).toBe('ESCALATED');
    expect(db.tasks.require(task.id).escalation_reason).toContain('author_blocked');
    expect(attention).toHaveLength(1);
    const human = issue('I1', { source: 'human', comment: 'Use SQLite' });
    transition(db, task.id, 'AUTHORING', { reason: 'human_send_back', actor: 'Alice', at: now });
    const response = author('revise');
    expect(response.cmd).toMatchObject({ type: 'author.revise', openIssues: [expect.objectContaining({ code: human.code, source: 'human', comment: 'Use SQLite' })] });
    deliver(submitted({ responses: [{ issue: 'I1', action: 'fixed', note: 'Used SQLite' }] }));
    expect(db.tasks.require(task.id).state).toBe('AWAITING_REVIEWER');
  });

  it('persists issue responses and sends rereview to the original paired reviewer', () => {
    pair();
    const blocking = issue();
    deliver(reviewed(), 'bob');
    expect(db.tasks.require(task.id).state).toBe('AUTHORING');
    deliver(submitted({ responses: [{ issue: blocking.code, action: 'fixed', note: 'Added boundary checks' }] }));
    expect(db.issues.require(blocking.id)).toMatchObject({ author_response: 'fixed', author_note: 'Added boundary checks', status: 'open' });
    expect(db.tasks.require(task.id)).toMatchObject({ state: 'IN_REVIEW', review_round: 2 });
    expect(latest('b').cmd).toMatchObject({ type: 'review.rereview', sid: 'b', conversationId: 'conversation', fromCommit: 'bbbbbbb', headCommit: 'ccccccc', reason: 'revision', authorSummary: 'Implemented feature' });
    expect(db.conversations.require('conversation')).toMatchObject({ state: 'active', reviewer_session_id: 'b', author_session_id: 'a' });
  });

  it('records an overlap warning without blocking the submitted task', () => {
    const other = db.tasks.insert({ title: 'Other', description: 'Other feature', requester_agent_id: 'bob', state: 'AUTHORING', files: '["src/feature.ts"]', created_at: now, updated_at: now, state_entered_at: now });
    author();
    deliver(submitted());
    expect(db.tasks.require(task.id).state).toBe('AWAITING_REVIEWER');
    const warning = db.taskEvents.find({ task_id: task.id, reason: 'overlap_warning' });
    expect(warning).toHaveLength(1);
    expect(warning[0]?.data).toContain(String(other.id));
  });
});

describe('effective reviews and bounded revision loops', () => {
  it('treats stated approval with a new blocking issue as changes', () => {
    pair();
    deliver(reviewed({ verdict: 'approve', newIssues: [{ severity: 'blocking', file: 'src/feature.ts', line: 7, comment: 'Missing boundary check' }] }), 'bob');
    expect(db.tasks.require(task.id)).toMatchObject({ state: 'AUTHORING', last_reviewed_commit: 'bbbbbbb' });
    expect(db.issues.find({ task_id: task.id })).toMatchObject([{ code: 'I1', source: 'reviewer', severity: 'blocking', status: 'open', raised_round: 1 }]);
    expect(latest('a').cmd.type).toBe('author.revise');
    expect(db.mergeQueue.all()).toHaveLength(0);
  });

  it('stops an approved task for a human when the requester asked to approve the merge', () => {
    pair();
    db.tasks.update(task.id, { require_human_approval: 1 });
    deliver(reviewed({ verdict: 'approve' }), 'bob');
    expect(db.tasks.require(task.id)).toMatchObject({ state: 'ESCALATED', escalation_reason: 'human_approval_required', last_reviewed_commit: 'bbbbbbb' });
    expect(db.mergeQueue.all()).toHaveLength(0);
  });

  it('approves suggestions even when the reviewer states request_changes', () => {
    pair();
    deliver(reviewed({ verdict: 'request_changes', newIssues: [{ severity: 'suggestion', file: null, line: null, comment: 'Consider a shorter helper name' }] }), 'bob');
    expect(db.tasks.require(task.id)).toMatchObject({ state: 'MERGE_QUEUED', approved_at: now, last_reviewed_commit: 'bbbbbbb' });
    expect(db.mergeQueue.require(task.id).enqueued_at).toBe(now);
    expect(db.issues.find({ severity: 'suggestion' })).toHaveLength(1);
    expect(db.usageLedger.all()[0]).toMatchObject({ kind: 'lent', role: 'reviewer', agent_id: 'bob', estimated: 100 });
  });

  it('keeps omitted open blocking issues open, then resolves them only on explicit review', () => {
    pair();
    const blocking = issue();
    deliver(reviewed({ previousIssues: [] }), 'bob');
    expect(db.issues.require(blocking.id).status).toBe('open');
    expect(db.tasks.require(task.id).state).toBe('AUTHORING');
    deliver(submitted({ responses: [{ issue: 'I1', action: 'fixed', note: 'Fixed' }] }));
    deliver(reviewed({ previousIssues: [{ issue: 'I1', status: 'resolved' }] }), 'bob');
    expect(db.issues.require(blocking.id).status).toBe('resolved');
    expect(db.tasks.require(task.id).state).toBe('MERGE_QUEUED');
  });

  it('uses unique increasing issue codes across existing issue history', () => {
    pair();
    issue('I10', { severity: 'suggestion' });
    deliver(reviewed({ newIssues: [{ severity: 'suggestion', file: null, line: null, comment: 'Another suggestion' }] }), 'bob');
    expect(db.issues.find({ task_id: task.id }).map((row) => row.code)).toEqual(['I10', 'I11']);
  });

  it('keeps the same immutable pairing for three rounds and escalates at the review limit', () => {
    pair();
    for (let round = 1; round <= 3; round += 1) {
      deliver(reviewed(round === 1
        ? { newIssues: [{ severity: 'blocking', file: null, line: null, comment: 'Still incorrect' }] }
        : { previousIssues: [{ issue: 'I1', status: 'still_open' }] }), 'bob');
      const current = db.tasks.require(task.id);
      expect(current.review_round).toBe(round);
      if (round < 3) {
        expect(current.state).toBe('AUTHORING');
        deliver(submitted({ headCommit: round === 1 ? 'ccccccc' : 'ddddddd', responses: [{ issue: 'I1', action: 'fixed', note: 'Revised' }] }));
        expect(latest('b').cmd).toMatchObject({ type: 'review.rereview', round: round + 1, sid: 'b', conversationId: 'conversation' });
      } else expect(current).toMatchObject({ state: 'ESCALATED', escalation_reason: 'review_round_limit' });
    }
    expect(db.conversations.all()).toHaveLength(1);
    expect(db.conversations.require('conversation').state).toBe('active');
    expect(attention.at(-1)?.message).toContain('review_round_limit');
  });

  it.each(['disputed', 'wontfix'] as const)('counts repeated %s issues and escalates before the round limit', (action) => {
    pair();
    const blocking = issue('I1', { author_response: action });
    deliver(reviewed({ previousIssues: [{ issue: 'I1', status: 'still_open' }] }), 'bob');
    expect(db.issues.require(blocking.id).dispute_count).toBe(1);
    deliver(submitted({ responses: [{ issue: 'I1', action, note: 'The implementation is intentional' }] }));
    deliver(reviewed({ previousIssues: [{ issue: 'I1', status: 'still_open' }] }), 'bob');
    expect(db.issues.require(blocking.id).dispute_count).toBe(2);
    expect(db.tasks.require(task.id)).toMatchObject({ state: 'ESCALATED', escalation_reason: 'dispute_limit', review_round: 2 });
  });

  it('goes directly to PAUSED when review needs an unavailable author', () => {
    pair();
    db.agents.update('alice', { status: 'offline' });
    deliver(reviewed({ newIssues: [{ severity: 'blocking', file: null, line: null, comment: 'Fix this' }] }), 'bob');
    expect(db.tasks.require(task.id)).toMatchObject({ state: 'PAUSED', paused_from_state: 'AUTHORING', pause_reason: 'author_unavailable' });
    expect(db.taskEvents.all()).toMatchObject([{ from_state: 'IN_REVIEW', to_state: 'PAUSED' }]);
    expect(commands.filter((frame) => frame.cmd.sid === 'a')).toHaveLength(0);
  });
});

describe('author synchronization', () => {
  it('requeues a clean synchronization without a review', () => {
    pair();
    db.tasks.update(task.id, { state: 'SYNCING', last_reviewed_commit: 'bbbbbbb' });
    author('sync');
    deliver(synced());
    expect(db.tasks.require(task.id)).toMatchObject({ state: 'MERGE_QUEUED', head_commit: 'ddddddd', sync_had_conflicts: 0 });
    expect(db.mergeQueue.get(task.id)).toBeDefined();
    expect(commands.filter((frame) => frame.cmd.sid === 'b')).toHaveLength(1);
  });

  it('resolves open system issues on passing sync without resolving reviewer or human issues', () => {
    const system = issue('I1', { source: 'system' });
    const reviewer = issue('I2', { source: 'reviewer' });
    const human = issue('I3', { source: 'human' });
    db.tasks.update(task.id, { state: 'SYNCING' });
    author('sync');
    deliver(synced());
    expect(db.issues.require(system.id).status).toBe('resolved');
    expect(db.issues.require(reviewer.id).status).toBe('open');
    expect(db.issues.require(human.id).status).toBe('open');
  });

  it('rereviews conflicts in the same pairing from the last reviewed commit', () => {
    pair();
    db.tasks.update(task.id, { state: 'SYNCING', last_reviewed_commit: 'bbbbbbb' });
    author('sync');
    deliver(synced({ hadConflicts: true }));
    expect(db.tasks.require(task.id)).toMatchObject({ state: 'IN_REVIEW', head_commit: 'ddddddd', sync_had_conflicts: 1, review_round: 2 });
    expect(latest('b').cmd).toMatchObject({ type: 'review.rereview', fromCommit: 'bbbbbbb', headCommit: 'ddddddd', reason: 'sync_conflicts' });
  });

  it('awaits a new reviewer after conflicted sync if the previous pairing was abandoned', () => {
    db.tasks.update(task.id, { state: 'SYNCING' });
    author('sync');
    deliver(synced({ hadConflicts: true }));
    expect(db.tasks.require(task.id).state).toBe('AWAITING_REVIEWER');
    expect(commands.filter((frame) => frame.cmd.sid === 'b')).toHaveLength(0);
  });

  it.each([0, 2])('handles synchronization test failure with %i prior fixes', (attempts) => {
    db.tasks.update(task.id, { state: 'SYNCING', test_fix_attempts: attempts });
    author('sync');
    deliver(synced({ tests: failed }));
    if (attempts === 0) {
      expect(db.tasks.require(task.id)).toMatchObject({ state: 'AUTHORING', test_fix_attempts: 1 });
      expect(latest('a').cmd.type).toBe('author.revise');
    } else expect(db.tasks.require(task.id).state).toBe('ESCALATED');
  });
});

describe('stale event guards and usage accounting', () => {
  it('ignores an old same-timestamp author reply while still recording its usage', () => {
    const old = author();
    const current = author('revise');
    expect(old.msgId).not.toBe(current.msgId);
    deliver(submitted({ inReplyTo: old.msgId, usage: { ...usage, inputTokens: 180, contextTokens: 999 } }));
    expect(db.tasks.require(task.id)).toMatchObject({ state: 'AUTHORING', head_commit: 'bbbbbbb' });
    expect(db.taskEvents.all()).toHaveLength(0);
    expect(db.usageLedger.all()).toHaveLength(1);
    expect(db.agents.require('alice').cost_ratio_ema).toBeCloseTo(1.2);
    expect(db.sessions.require('a').context_tokens).toBe(999);
    deliver(submitted({ inReplyTo: current.msgId }));
    expect(db.tasks.require(task.id).state).toBe('AWAITING_REVIEWER');
  });

  it('ignores review results for the wrong head and preserves actual lent usage', () => {
    pair();
    deliver(reviewed({}, { reviewedCommit: 'ffffff0' }), 'bob');
    expect(db.tasks.require(task.id).state).toBe('IN_REVIEW');
    expect(db.mergeQueue.all()).toHaveLength(0);
    expect(db.usageLedger.all()).toMatchObject([{ kind: 'lent', role: 'reviewer', agent_id: 'bob' }]);
  });

  it('ignores task results in an unexpected state, keeping locks and ledger intact', () => {
    author();
    db.tasks.update(task.id, { state: 'ESCALATED' });
    deliver(submitted());
    expect(db.tasks.require(task.id).state).toBe('ESCALATED');
    expect(db.taskEvents.all()).toHaveLength(0);
    expect(db.usageLedger.all()).toHaveLength(1);
    expect(db.sessions.require('a').lock_ref).toBe(String(task.id));
  });

  it('ignores delayed author results after its session has been reassigned to a different task', () => {
    author();
    const delayed = submitted();
    const other = db.tasks.insert({ title: 'Other', description: 'Other', requester_agent_id: 'alice', author_agent_id: 'alice', author_session_id: 'a', state: 'AUTHORING', created_at: now, updated_at: now, state_entered_at: now });
    locks.releaseSession('a', 'idle');
    locks.lockSession('a', 'task', String(other.id), 'author');
    deliver(delayed);
    expect(db.tasks.require(task.id)).toMatchObject({ state: 'AUTHORING', head_commit: 'bbbbbbb' });
    expect(db.sessions.require('a').lock_ref).toBe(String(other.id));
    expect(db.usageLedger.all()).toHaveLength(1);
    expect(db.taskEvents.all()).toHaveLength(0);
  });

  it('ignores a result from a different conversation even when its reviewer session matches', () => {
    pair();
    deliver(reviewed({}, { conversationId: 'abandoned-conversation' }), 'bob');
    expect(db.tasks.require(task.id).state).toBe('IN_REVIEW');
    expect(db.mergeQueue.all()).toHaveLength(0);
    expect(db.usageLedger.all()).toHaveLength(1);
  });

  it('counts a teammate agent with the same human owner as own usage', () => {
    db.tasks.update(task.id, { state: 'IN_REVIEW' });
    locks.lockSession('c', 'task', String(task.id), 'reviewer');
    db.conversations.insert({ id: 'same-owner', task_id: task.id, author_agent_id: 'alice', author_session_id: 'a', reviewer_agent_id: 'carol', reviewer_session_id: 'c', state: 'active', created_at: now });
    const frame = handlers.sendReview(task.id, 'same-owner', 'start');
    deliver(reviewed({}, { sid: 'c', conversationId: 'same-owner', inReplyTo: frame.msgId }), 'carol');
    expect(db.usageLedger.all()).toMatchObject([{ kind: 'own', role: 'reviewer', agent_id: 'carol' }]);
  });
});

describe('session events', () => {
  it('matches an opening result to its command and calls the scheduler hook after setting idle', () => {
    db.sessions.update('a2', { state: 'opening' });
    const frame = locks.sendToAgent('alice', { type: 'session.open', sid: 'a2', profile: 'author' });
    let called = false;
    handlers = new EventHandlers(db, config, locks, { now: () => now, onSessionOpened: (snapshot, event, request) => {
      expect(snapshot.id).toBe('a2');
      expect(event.ok).toBe(true);
      expect(request.id).toBe(frame.msgId);
      expect(db.sessions.require('a2').state).toBe('idle');
      called = true;
    } });
    deliver({ type: 'session.opened', inReplyTo: frame.msgId, sid: 'a2', ok: true });
    expect(called).toBe(true);
  });

  it('marks a failed session open lost', () => {
    db.sessions.update('a2', { state: 'opening' });
    const frame = locks.sendToAgent('alice', { type: 'session.open', sid: 'a2', profile: 'author' });
    deliver({ type: 'session.opened', inReplyTo: frame.msgId, sid: 'a2', ok: false, error: 'Could not start adapter' });
    expect(db.sessions.require('a2').state).toBe('lost');
  });

  it('rolls back session-open state when its assignment callback fails', () => {
    db.sessions.update('a2', { state: 'opening' });
    const frame = locks.sendToAgent('alice', { type: 'session.open', sid: 'a2', profile: 'author' });
    handlers = new EventHandlers(db, config, locks, { now: () => now, onSessionOpened: () => { throw new Error('assignment failed'); } });
    expect(() => deliver({ type: 'session.opened', inReplyTo: frame.msgId, sid: 'a2', ok: true })).toThrow('assignment failed');
    expect(db.sessions.require('a2').state).toBe('opening');
  });

  it('closes an unlocked session and records compaction in the same logical session', () => {
    deliver({ type: 'session.compacted', sid: 'a', contextTokensBefore: 1000, contextTokensAfter: 250 });
    expect(db.sessions.require('a')).toMatchObject({ id: 'a', context_tokens: 250, state: 'locked' });
    db.sessions.update('a2', { state: 'closing' });
    const frame = locks.sendToAgent('alice', { type: 'session.close', sid: 'a2' });
    deliver({ type: 'session.closed', inReplyTo: frame.msgId, sid: 'a2' });
    expect(db.sessions.require('a2')).toMatchObject({ state: 'closed', closed_at: now });
  });

  it('stores an author checkpoint without treating it as a completed turn', () => {
    db.tasks.update(task.id, { turn_retries: 1 });
    deliver({ type: 'author.checkpoint', sid: 'a', taskId: task.id, commit: 'eeeeeee' });
    expect(db.tasks.require(task.id)).toMatchObject({ head_commit: 'eeeeeee', state: 'AUTHORING', turn_retries: 1 });
    expect(db.taskEvents.all()).toHaveLength(0);
  });

  it('pauses an author session loss and abandons reviewer loss during a review', () => {
    pair();
    const snapshot = db.sessions.require('b');
    handlers.sessionLost(snapshot, 'disconnected');
    expect(db.tasks.require(task.id).state).toBe('AWAITING_REVIEWER');
    expect(db.conversations.require('conversation').state).toBe('abandoned');
    expect(db.sessions.require('b')).toMatchObject({ state: 'lost', lock_kind: null });
    db.tasks.update(task.id, { state: 'AUTHORING' });
    deliver({ type: 'session.lost', sid: 'a', reason: 'adapter died' });
    expect(db.tasks.require(task.id)).toMatchObject({ state: 'PAUSED', paused_from_state: 'AUTHORING' });
    expect(db.sessions.require('a').state).toBe('lost');
  });

  it('abandons a lost reviewer while preserving an ongoing author turn', () => {
    pair();
    db.tasks.update(task.id, { state: 'AUTHORING' });
    handlers.sessionLost(db.sessions.require('b'), 'disconnected');
    expect(db.tasks.require(task.id).state).toBe('AUTHORING');
    expect(db.conversations.require('conversation').state).toBe('abandoned');
    expect(db.sessions.require('a').state).toBe('locked');
  });
});

describe('turn failures', () => {
  it('retries invalid output with a new msgId, then escalates the author when retries are exhausted', () => {
    const first = author();
    deliver(failure('a', 'INVALID_OUTPUT'));
    expect(db.tasks.require(task.id)).toMatchObject({ state: 'AUTHORING', turn_retries: 1 });
    expect(latest('a').msgId).not.toBe(first.msgId);
    expect(latest('a').cmd).toEqual(first.cmd);
    deliver(failure('a', 'INVALID_OUTPUT'));
    expect(db.tasks.require(task.id)).toMatchObject({ state: 'ESCALATED', escalation_reason: 'author_turn_failed:INVALID_OUTPUT', turn_retries: 2 });
  });

  it('reassigns a reviewer after failed retries and abandons that conversation', () => {
    pair();
    deliver(failure('b', 'ADAPTER_ERROR'), 'bob');
    deliver(failure('b', 'ADAPTER_ERROR'), 'bob');
    expect(db.tasks.require(task.id).state).toBe('AWAITING_REVIEWER');
    expect(db.conversations.require('conversation').state).toBe('abandoned');
    expect(['idle', 'lost']).toContain(db.sessions.require('b').state);
  });

  it('ignores expected cancellation failures', () => {
    author();
    deliver(failure('a', 'CANCELLED'));
    expect(db.tasks.require(task.id)).toMatchObject({ state: 'AUTHORING', turn_retries: 0 });
    expect(commands).toHaveLength(1);
    expect(db.taskEvents.all()).toHaveLength(0);
  });

  it('re-runs finished-task cleanup when a cancelled task\'s turn confirms the cancel (stale branch push race)', () => {
    const finished: number[] = [];
    handlers = new EventHandlers(db, config, locks, { now: () => now, onFinished: (t) => finished.push(t.id) });
    author();
    const cmd = latest('a');
    handlers.finishTask(task.id, 'CANCELLED', 'cancelled_by_human', 'human:Alice');
    expect(finished).toEqual([task.id]);
    deliver(failure('a', 'CANCELLED', { inReplyTo: cmd.msgId }));
    expect(finished).toEqual([task.id, task.id]);
    expect(db.tasks.require(task.id).state).toBe('CANCELLED');
  });

  it.each([undefined, 999])('ignores turn failures with nonmatching task scope %s but charges usage', (taskId) => {
    author();
    deliver(failure('a', 'ADAPTER_ERROR', { taskId, usage }));
    expect(db.tasks.require(task.id)).toMatchObject({ state: 'AUTHORING', turn_retries: 0 });
    expect(commands).toHaveLength(1);
    expect(db.taskEvents.all()).toHaveLength(0);
    expect(db.usageLedger.all()).toHaveLength(1);
  });

  it('fails unrecoverable git errors and releases task locks', () => {
    author();
    deliver(failure('a', 'GIT_ERROR'));
    expect(db.tasks.require(task.id).state).toBe('FAILED');
    expect(db.sessions.require('a')).toMatchObject({ state: 'idle', lock_ref: null });
  });

  it('pauses rate-limited authors with the supplied reset time', () => {
    author();
    deliver(failure('a', 'RATE_LIMITED', { resetAt: now + 60_000 }));
    expect(db.agents.require('alice').rate_limited_until).toBe(now + 60_000);
    expect(db.tasks.require(task.id)).toMatchObject({ state: 'PAUSED', paused_from_state: 'AUTHORING', pause_reason: 'rate_limited' });
  });

  it('reassigns rate-limited reviewers with a default fifteen-minute backoff', () => {
    pair();
    deliver(failure('b', 'RATE_LIMITED'), 'bob');
    expect(db.agents.require('bob').rate_limited_until).toBe(now + 15 * 60_000);
    expect(db.tasks.require(task.id).state).toBe('AWAITING_REVIEWER');
    expect(db.conversations.require('conversation').state).toBe('abandoned');
  });
});

describe('directives and terminal task cleanup', () => {
  function runningDirective() {
    db.directives.insert({ id: 'directive', requester: 'Alice', agent_id: 'bob', session_id: 'b', text: 'Explain the design', state: 'running', created_at: now });
    locks.lockSession('b', 'directive', 'directive', 'directive');
    return locks.sendToSession('b', { type: 'directive.run', sid: 'b', directiveId: 'directive', requester: 'Alice', text: 'Explain the design', estimated: 100 });
  }

  it('completes a directive, records usage, and frees its session', () => {
    const frame = runningDirective();
    deliver({ type: 'directive.completed', sid: 'b', directiveId: 'directive', inReplyTo: frame.msgId, text: 'The design uses isolated sessions', usage }, 'bob');
    expect(db.directives.require('directive')).toMatchObject({ state: 'done', result_text: 'The design uses isolated sessions', finished_at: now });
    expect(db.sessions.require('b')).toMatchObject({ state: 'idle', lock_kind: null });
    expect(db.usageLedger.all()).toMatchObject([{ kind: 'lent', role: 'directive', directive_id: 'directive', task_id: null }]);
  });

  it('requeues a rate-limited directive and releases its session', () => {
    const frame = runningDirective();
    deliver({ type: 'turn.failed', sid: 'b', directiveId: 'directive', inReplyTo: frame.msgId, code: 'RATE_LIMITED', message: 'Quota exhausted' }, 'bob');
    expect(db.directives.require('directive').state).toBe('queued');
    expect(db.sessions.require('b').state).toBe('idle');
    expect(db.agents.require('bob').rate_limited_until).toBe(now + 15 * 60_000);
  });

  it('fails a directive on session loss', () => {
    runningDirective();
    handlers.sessionLost(db.sessions.require('b'), 'crashed');
    expect(db.directives.require('directive')).toMatchObject({ state: 'failed', error: 'session_lost', finished_at: now });
    expect(db.sessions.require('b').state).toBe('lost');
  });

  it('retries a directive failure once, then fails and releases it', () => {
    const frame = runningDirective();
    deliver({ type: 'turn.failed', sid: 'b', directiveId: 'directive', inReplyTo: frame.msgId, code: 'ADAPTER_ERROR', message: 'Adapter unavailable' }, 'bob');
    expect(latest('b').msgId).not.toBe(frame.msgId);
    expect(db.directives.require('directive').state).toBe('running');
    deliver({ type: 'turn.failed', sid: 'b', directiveId: 'directive', inReplyTo: latest('b').msgId, code: 'ADAPTER_ERROR', message: 'Adapter unavailable' }, 'bob');
    expect(db.directives.require('directive')).toMatchObject({ state: 'failed', error: 'Adapter unavailable', finished_at: now });
    expect(db.sessions.require('b').state).toBe('idle');
  });

  it('cancels both participants before releasing locks and removes pending merge work', () => {
    pair();
    db.mergeQueue.insert({ task_id: task.id, enqueued_at: now });
    handlers.finishTask(task.id, 'CANCELLED', 'human_cancel', 'Alice');
    expect(db.tasks.require(task.id).state).toBe('CANCELLED');
    expect(db.conversations.require('conversation')).toMatchObject({ state: 'closed', ended_at: now });
    expect(db.sessions.require('a')).toMatchObject({ state: 'idle', lock_kind: null });
    expect(db.sessions.require('b')).toMatchObject({ state: 'idle', lock_kind: null });
    expect(commands.filter((frame) => frame.cmd.type === 'task.cancel').map((frame) => frame.cmd.sid).sort()).toEqual(['a', 'b']);
    expect(db.mergeQueue.get(task.id)).toBeUndefined();
    handlers.finishTask(task.id, 'CANCELLED', 'human_cancel', 'Alice');
    expect(db.taskEvents.all()).toHaveLength(1);
  });

  it('finishes a merged task only from MERGING and closes the pairing', () => {
    pair();
    db.tasks.update(task.id, { state: 'MERGING' });
    handlers.finishTask(task.id, 'MERGED', 'merge_succeeded');
    expect(db.tasks.require(task.id).state).toBe('MERGED');
    expect(db.conversations.require('conversation').state).toBe('closed');
    expect(db.sessions.require('a').state).toBe('idle');
    expect(db.sessions.require('b').state).toBe('idle');
  });
});

describe('fake-node review integration', () => {
  it('routes a two-round review through real sockets and deduplicates repeated result frames', async () => {
    for (const agentId of ['alice', 'bob']) {
      db.agents.update(agentId, { token_hash: createHash('sha256').update(`token-${agentId}`).digest('hex') });
    }
    config.listen = { host: '127.0.0.1', port: 0 };
    locks = new LockManager(db, { leaseSec: 120, now: () => now, deliver: (agentId, frame) => {
      commands.push(frame);
      hub.deliver(agentId, frame);
    } });
    handlers = new EventHandlers(db, config, locks, { now: () => now });
    const hub = new NodeHub(db, config, { locks, now: () => now, onEvent: (agentId, event) => { handlers.handle(agentId, event); } });
    const { url } = await hub.start();
    const nodes: FakeNode[] = [];
    try {
      const alice = await FakeNode.connect(url, FakeNode.hello('alice', 'token-alice', { sessions: [{ sid: 'a', alive: true, busy: false, contextTokens: 0 }] }));
      nodes.push(alice);
      const bob = await FakeNode.connect(url, FakeNode.hello('bob', 'token-bob', { sessions: [{ sid: 'b', alive: true, busy: false, contextTokens: 0 }] }));
      nodes.push(bob);
      await alice.next('welcome');
      await bob.next('welcome');
      author();
      await alice.next('cmd');
      const initialResult = submitted({ headCommit: 'bbbbbbb' });
      const initialMsgId = alice.event(initialResult);
      await alice.next('ack', (frame) => frame.msgId === initialMsgId);
      expect(db.tasks.require(task.id).state).toBe('AWAITING_REVIEWER');
      pair();
      const firstReview = await bob.next('cmd');
      expect(firstReview.cmd).toMatchObject({ type: 'review.start', sid: 'b', conversationId: 'conversation', round: 1 });
      const reviewMsgId = bob.event(reviewed({ newIssues: [{ severity: 'blocking', file: null, line: null, comment: 'Fix the boundary condition' }] }));
      await bob.next('ack', (frame) => frame.msgId === reviewMsgId);
      expect((await alice.next('cmd')).cmd.type).toBe('author.revise');
      const revisedMsgId = alice.event(submitted({ responses: [{ issue: 'I1', action: 'fixed', note: 'Added a test and fixed it' }] }));
      await alice.next('ack', (frame) => frame.msgId === revisedMsgId);
      expect((await bob.next('cmd')).cmd).toMatchObject({ type: 'review.rereview', sid: 'b', conversationId: 'conversation', round: 2 });
      const approved = reviewed({ previousIssues: [{ issue: 'I1', status: 'resolved' }] });
      const approvalMsgId = bob.event(approved);
      await bob.next('ack', (frame) => frame.msgId === approvalMsgId);
      expect(db.tasks.require(task.id).state).toBe('MERGE_QUEUED');
      expect(db.mergeQueue.get(task.id)).toBeDefined();
      expect(db.usageLedger.all()).toHaveLength(4);
      bob.event(approved, approvalMsgId);
      await bob.next('ack', (frame) => frame.msgId === approvalMsgId);
      expect(db.usageLedger.all()).toHaveLength(4);
      expect(db.taskEvents.all()).toHaveLength(4);
      expect(db.conversations.all()).toHaveLength(1);
      expect(alice.errors).toEqual([]);
      expect(bob.errors).toEqual([]);
    } finally {
      await Promise.all(nodes.map((node) => node.close()));
      await hub.close();
    }
  });
});
