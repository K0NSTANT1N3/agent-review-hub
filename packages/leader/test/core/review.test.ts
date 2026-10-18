import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReviewOutput } from '@quorum/protocol';
import { openDatabase, type IssueRow, type LeaderDb, type TaskRow } from '../../src/db/repo.js';
import { applyReview, nextIssueCode } from '../../src/core/review.js';

let db: LeaderDb;
let task: TaskRow;
beforeEach(() => {
  db = openDatabase(':memory:');
  for (const id of ['author', 'reviewer']) {
    db.agents.insert({ id, owner_name: id, token_hash: 'hash', created_at: 1 });
    db.sessions.insert({ id: `s-${id}`, agent_id: id, state: 'idle', created_at: 1, last_used_at: 1 });
  }
  task = db.tasks.insert({ title: 'Feature', description: 'Implement', requester_agent_id: 'author',
    state: 'IN_REVIEW', review_round: 2, created_at: 1, updated_at: 1, state_entered_at: 1 });
  db.conversations.insert({ id: 'conversation', task_id: task.id, author_agent_id: 'author', author_session_id: 's-author',
    reviewer_agent_id: 'reviewer', reviewer_session_id: 's-reviewer', state: 'active', created_at: 1 });
});
afterEach(() => { db.close(); });

function issue(patch: Partial<IssueRow> = {}): IssueRow {
  return db.issues.insert({ task_id: task.id, code: nextIssueCode(db, task.id), source: 'reviewer',
    severity: 'blocking', comment: 'Fix this', status: 'open', raised_round: 1, created_at: 1, ...patch });
}

function review(patch: Partial<ReviewOutput> = {}): ReviewOutput {
  return { verdict: 'approve', summary: 'Review complete', previousIssues: [], newIssues: [], ...patch };
}

describe('effective review verdict', () => {
  it('ignores a stated approval while a previously open blocker is missing from the response', () => {
    const blocker = issue();
    expect(applyReview(db, task, 'conversation', review(), 10)).toEqual({ verdict: 'changes', openBlocking: [blocker] });
    expect(db.issues.require(blocker.id).status).toBe('open');
  });

  it('approves without blockers even when the stated verdict requests changes', () => {
    issue({ severity: 'suggestion' });
    issue({ status: 'resolved' });
    issue({ status: 'closed_by_human', source: 'human' });
    expect(applyReview(db, task, 'conversation', review({ verdict: 'request_changes' }), 10))
      .toEqual({ verdict: 'approve', openBlocking: [] });
  });

  it('resolves reported issues while leaving omitted blockers open', () => {
    const resolved = issue();
    const omitted = issue();
    const result = applyReview(db, task, 'conversation', review({ previousIssues: [{ issue: resolved.code, status: 'resolved' }] }), 10);
    expect(result).toEqual({ verdict: 'changes', openBlocking: [omitted] });
    expect(db.issues.require(resolved.id).status).toBe('resolved');
  });

  it('approves when the final blocker resolves; remaining suggestions are optional', () => {
    const blocker = issue();
    const suggestion = issue({ severity: 'suggestion' });
    expect(applyReview(db, task, 'conversation', review({ previousIssues: [{ issue: blocker.code, status: 'resolved' }] }), 10))
      .toEqual({ verdict: 'approve', openBlocking: [] });
    expect(db.issues.require(suggestion.id).status).toBe('open');
  });

  it('does not reopen resolved or human-closed issues reported still_open', () => {
    const resolved = issue({ status: 'resolved' });
    const closed = issue({ status: 'closed_by_human' });
    const output = review({ previousIssues: [resolved, closed].map((row) => ({ issue: row.code, status: 'still_open' })) });
    expect(applyReview(db, task, 'conversation', output, 10).verdict).toBe('approve');
    expect(db.issues.require(resolved.id).status).toBe('resolved');
    expect(db.issues.require(closed.id).status).toBe('closed_by_human');
  });

  it('ignores unknown codes and issues from other tasks', () => {
    const other = db.tasks.insert({ title: 'Other', description: '', requester_agent_id: 'author', state: 'IN_REVIEW',
      created_at: 1, updated_at: 1, state_entered_at: 1 });
    const otherIssue = issue({ task_id: other.id, code: 'I99' });
    const output = review({ previousIssues: [{ issue: 'I99', status: 'resolved' }] });
    expect(applyReview(db, task, 'conversation', output, 10).verdict).toBe('approve');
    expect(db.issues.require(otherIssue.id).status).toBe('open');
  });

  it('creates blocking and suggestion issues with task, conversation and review round attribution', () => {
    const output = review({ newIssues: [
      { severity: 'blocking', file: 'src/index.ts', line: 42, comment: 'Missing guard' },
      { severity: 'suggestion', file: null, line: null, comment: 'Simplify' },
    ] });
    const result = applyReview(db, task, 'conversation', output, 10);
    const rows = db.issues.find({ task_id: task.id });
    expect(rows).toEqual([
      expect.objectContaining({ code: 'I1', source: 'reviewer', severity: 'blocking', file: 'src/index.ts', line: 42,
        status: 'open', raised_round: 2, conversation_id: 'conversation', created_at: 10 }),
      expect.objectContaining({ code: 'I2', source: 'reviewer', severity: 'suggestion', file: null, line: null,
        status: 'open', raised_round: 2, conversation_id: 'conversation', created_at: 10 }),
    ]);
    expect(result).toEqual({ verdict: 'changes', openBlocking: [rows[0]] });
  });
});

describe('disputes and issue codes', () => {
  for (const action of ['disputed', 'wontfix'] as const) {
    it(`increments ${action} once per accepted review, even if a code is duplicated`, () => {
      const blocker = issue({ author_response: action, dispute_count: 2 });
      const previous = { issue: blocker.code, status: 'still_open' as const };
      const output = review({ previousIssues: [previous, previous] });
      applyReview(db, task, 'conversation', output, 10);
      expect(db.issues.require(blocker.id).dispute_count).toBe(3);
      applyReview(db, task, 'conversation', output, 11);
      expect(db.issues.require(blocker.id).dispute_count).toBe(4);
    });
  }

  it('does not count fixed, unanswered, omitted, or resolved disputes', () => {
    const fixed = issue({ author_response: 'fixed' });
    const unanswered = issue();
    const omitted = issue({ author_response: 'disputed' });
    const resolved = issue({ author_response: 'wontfix' });
    applyReview(db, task, 'conversation', review({ previousIssues: [
      { issue: fixed.code, status: 'still_open' },
      { issue: unanswered.code, status: 'still_open' },
      { issue: resolved.code, status: 'resolved' },
    ] }), 10);
    for (const row of [fixed, unanswered, omitted, resolved]) expect(db.issues.require(row.id).dispute_count).toBe(0);
  });

  it('allocates codes above all prior human, system and resolved issues rather than issue count', () => {
    issue({ code: 'I2' });
    issue({ code: 'I9', source: 'human', status: 'closed_by_human' });
    issue({ code: 'I15', source: 'system', status: 'resolved' });
    expect(nextIssueCode(db, task.id)).toBe('I16');
    applyReview(db, task, 'conversation', review({ newIssues: [
      { severity: 'suggestion', file: null, line: null, comment: 'First' },
      { severity: 'suggestion', file: null, line: null, comment: 'Second' },
    ] }), 10);
    expect(db.issues.find({ task_id: task.id }).map((row) => row.code)).toEqual(['I2', 'I9', 'I15', 'I16', 'I17']);
    expect(nextIssueCode(db, task.id)).toBe('I18');
  });

  it('preserves exact numbering above JavaScript safe integer range', () => {
    issue({ code: 'I9007199254740993' });
    expect(nextIssueCode(db, task.id)).toBe('I9007199254740994');
  });
});

describe('atomic review bookkeeping', () => {
  it('participates in the caller transaction and rolls back issue updates and inserts together', () => {
    const blocker = issue({ author_response: 'disputed' });
    expect(() => db.withTx(() => {
      applyReview(db, task, 'conversation', review({
        previousIssues: [{ issue: blocker.code, status: 'resolved' }],
        newIssues: [{ severity: 'blocking', file: null, line: null, comment: 'New blocker' }],
      }), 10);
      throw new Error('Handler failed');
    })).toThrow('Handler failed');
    expect(db.issues.all()).toEqual([blocker]);
  });

  it('rejects a conversation belonging to a different task before any mutations', () => {
    const other = db.tasks.insert({ title: 'Other', description: '', requester_agent_id: 'author', state: 'IN_REVIEW',
      created_at: 1, updated_at: 1, state_entered_at: 1 });
    const blocker = issue({ task_id: other.id });
    expect(() => applyReview(db, other, 'conversation', review({ previousIssues: [{ issue: blocker.code, status: 'resolved' }] }), 10))
      .toThrow('another task');
    expect(db.issues.require(blocker.id)).toEqual(blocker);
  });

  it('validates outputs and timestamps without changing any issue', () => {
    const blocker = issue();
    expect(() => applyReview(db, task, 'conversation', review({ summary: '' }), 10)).toThrow();
    expect(() => applyReview(db, task, 'conversation', review(), Number.NaN)).toThrow(TypeError);
    expect(db.issues.all()).toEqual([blocker]);
  });
});
