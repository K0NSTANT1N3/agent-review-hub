import { CommandSchema } from '@quorum/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authorRevise, authorStart, authorSync, reviewRereview, reviewStart,
} from '../../src/core/commands.js';
import { openDatabase, type ConversationRow, type IssueRow, type LeaderDb, type TaskRow } from '../../src/db/repo.js';

let db: LeaderDb;
let task: TaskRow;
let conversation: ConversationRow;
beforeEach(() => {
  db = openDatabase(':memory:');
  db.agents.insert({ id: 'author', owner_name: 'Alice', token_hash: 'hash', created_at: 1 });
  db.agents.insert({ id: 'reviewer', owner_name: 'Bob', token_hash: 'hash', created_at: 1 });
  for (const id of ['author', 'reviewer']) {
    db.sessions.insert({ id: `s-${id}`, agent_id: id, state: 'idle', created_at: 1, last_used_at: 1 });
  }
  task = db.tasks.insert({ title: 'Feature', description: 'Implement it', tags: '["typescript"]', requester_agent_id: 'author',
    author_agent_id: 'author', author_session_id: 's-author', branch: 'quorum/task-1', base_commit: 'aaaaaaa',
    head_commit: 'bbbbbbb', last_reviewed_commit: 'ccccccc', review_round: 2, last_test_output: 'Tests passed',
    state: 'IN_REVIEW', created_at: 1, updated_at: 1, state_entered_at: 1 });
  conversation = db.conversations.insert({ id: 'conversation', task_id: task.id, author_agent_id: 'author', author_session_id: 's-author',
    reviewer_agent_id: 'reviewer', reviewer_session_id: 's-reviewer', state: 'active', created_at: 1 });
});
afterEach(() => { db.close(); });

function issue(code: string, patch: Partial<IssueRow> = {}): IssueRow {
  return db.issues.insert({ task_id: task.id, code, source: 'reviewer', severity: 'blocking', comment: `Fix ${code}`,
    status: 'open', raised_round: 1, created_at: 1, ...patch });
}

describe('typed command builders', () => {
  it('builds author.start with the explicit session, requester owner and full issue history', () => {
    issue('I1', { file: 'src/index.ts', line: 5 });
    issue('I2', { status: 'resolved', source: 'human' });
    issue('I3', { status: 'closed_by_human', source: 'system' });
    const command = authorStart(db, task, 'new-author-session', 1234, true);
    expect(CommandSchema.parse(command)).toEqual(command);
    expect(command).toEqual({
      type: 'author.start', sid: 'new-author-session', taskId: task.id,
      task: { id: task.id, title: 'Feature', description: 'Implement it', tags: ['typescript'], requester: 'Alice' },
      branch: 'quorum/task-1', continueExisting: true, estimated: 1234,
      issues: [
        { code: 'I1', severity: 'blocking', source: 'reviewer', file: 'src/index.ts', line: 5, comment: 'Fix I1' },
        { code: 'I2', severity: 'blocking', source: 'human', file: null, line: null, comment: 'Fix I2' },
        { code: 'I3', severity: 'blocking', source: 'system', file: null, line: null, comment: 'Fix I3' },
      ],
    });
  });

  it('builds a fresh author.start with no inherited issues', () => {
    expect(authorStart(db, task, 's-author', 0, false)).toMatchObject({ continueExisting: false, issues: [], estimated: 0 });
  });

  it('splits only open blocking issues and suggestions in author.revise', () => {
    issue('I1');
    issue('I2', { severity: 'suggestion' });
    issue('I3', { status: 'resolved' });
    issue('I4', { severity: 'suggestion', status: 'closed_by_human' });
    const command = authorRevise(db, task, 2000);
    expect(CommandSchema.parse(command)).toEqual(command);
    expect(command).toMatchObject({ type: 'author.revise', sid: 's-author', conversationId: 'conversation',
      round: 2, testFailure: 'Tests passed', estimated: 2000 });
    expect(command.openIssues.map((row) => row.code)).toEqual(['I1']);
    expect(command.suggestions.map((row) => row.code)).toEqual(['I2']);
  });

  it('allows test-failure revisions before any reviewer round or active conversation', () => {
    db.conversations.update(conversation.id, { state: 'abandoned' });
    const command = authorRevise(db, { ...task, review_round: 0, last_test_output: 'Assertion failed' }, 100);
    expect(CommandSchema.parse(command)).toEqual(command);
    expect(command).toMatchObject({ conversationId: null, round: 0, testFailure: 'Assertion failed' });
  });

  it('sends all open reviewer/human issues across conversations to reviewers while keeping system issues author-only', () => {
    db.conversations.update(conversation.id, { state: 'abandoned' });
    const replacement = db.conversations.insert({ ...conversation, id: 'replacement', state: 'active' });
    issue('I1', { conversation_id: conversation.id, author_response: 'disputed' });
    issue('I2', { source: 'human', comment: 'Human send-back request' });
    issue('I3', { severity: 'suggestion', conversation_id: conversation.id });
    issue('I4', { source: 'human', severity: 'suggestion' });
    issue('I5', { source: 'system', conversation_id: replacement.id });
    issue('I6', { source: 'system', severity: 'suggestion' });
    issue('I7', { status: 'resolved' });
    issue('I8', { source: 'human', status: 'closed_by_human' });
    const other = db.tasks.insert({ title: 'Other task', description: '', requester_agent_id: 'author', state: 'QUEUED',
      created_at: 1, updated_at: 1, state_entered_at: 1 });
    issue('I9', { task_id: other.id });

    const start = reviewStart(db, task, replacement, 1000);
    const rereview = reviewRereview(db, task, replacement, 1000, 'Revision', 'revision');
    expect(CommandSchema.parse(start)).toEqual(start);
    expect(CommandSchema.parse(rereview)).toEqual(rereview);
    expect(start.priorIssues.map((row) => row.code)).toEqual(['I1', 'I2', 'I3', 'I4']);
    expect(rereview.openIssues.map((row) => row.code)).toEqual(['I1', 'I2', 'I3', 'I4']);
    expect(rereview.openIssues[0]?.authorResponse).toBe('disputed');

    const revise = authorRevise(db, task, 1000);
    expect(revise.openIssues.map((row) => row.code)).toEqual(['I1', 'I2', 'I5']);
    expect(revise.suggestions.map((row) => row.code)).toEqual(['I3', 'I4', 'I6']);
  });

  it('builds author.sync from the current branch and author session', () => {
    const command = authorSync(db, task, 'trunk', 3000);
    expect(CommandSchema.parse(command)).toEqual(command);
    expect(command).toEqual({ type: 'author.sync', sid: 's-author', taskId: task.id,
      branch: 'quorum/task-1', mainBranch: 'trunk', estimated: 3000 });
  });

  it('builds review.start with both kinds of open prior issues and test summary', () => {
    issue('I1');
    issue('I2', { severity: 'suggestion' });
    issue('I3', { status: 'resolved' });
    const command = reviewStart(db, task, conversation, 4000);
    expect(CommandSchema.parse(command)).toEqual(command);
    expect(command).toMatchObject({ type: 'review.start', sid: 's-reviewer', conversationId: 'conversation', round: 2,
      branch: 'quorum/task-1', baseCommit: 'aaaaaaa', headCommit: 'bbbbbbb', testSummary: 'Tests passed', estimated: 4000 });
    expect(command.priorIssues.map((row) => row.code)).toEqual(['I1', 'I2']);
    expect(reviewStart(db, { ...task, last_test_output: null }, conversation, 1).testSummary).toBe('');
  });

  for (const reason of ['revision', 'sync_conflicts'] as const) {
    it(`builds review.rereview for ${reason} with the last reviewed delta and author responses`, () => {
      issue('I1', { author_response: 'disputed', author_note: 'This is intentional' });
      issue('I2', { severity: 'suggestion' });
      issue('I3', { status: 'resolved', author_response: 'fixed' });
      const command = reviewRereview(db, task, conversation, 5000, 'Fixed the guard', reason);
      expect(CommandSchema.parse(command)).toEqual(command);
      expect(command).toMatchObject({ type: 'review.rereview', sid: 's-reviewer', conversationId: 'conversation',
        fromCommit: 'ccccccc', headCommit: 'bbbbbbb', baseCommit: 'aaaaaaa', authorSummary: 'Fixed the guard', reason, estimated: 5000 });
      expect(command.openIssues).toEqual([
        { code: 'I1', severity: 'blocking', source: 'reviewer', file: null, line: null,
          comment: 'Fix I1', authorResponse: 'disputed', authorNote: 'This is intentional' },
        { code: 'I2', severity: 'suggestion', source: 'reviewer', file: null, line: null,
          comment: 'Fix I2', authorResponse: null, authorNote: null },
      ]);
    });
  }

  it('does not mutate the task, issue state, sessions or messages while building commands', () => {
    const existing = issue('I1');
    const sessions = db.sessions.all();
    authorStart(db, task, 's-author', 1, false);
    authorRevise(db, task, 1);
    authorSync(db, task, 'main', 1);
    reviewStart(db, task, conversation, 1);
    reviewRereview(db, task, conversation, 1, 'Summary', 'revision');
    expect(db.tasks.require(task.id)).toEqual(task);
    expect(db.issues.all()).toEqual([existing]);
    expect(db.sessions.all()).toEqual(sessions);
    expect(db.messages.all()).toEqual([]);
    expect(db.taskEvents.all()).toEqual([]);
  });
});

describe('builder validation', () => {
  it('requires branches, author sessions, current commits and the last reviewed commit where applicable', () => {
    expect(() => authorStart(db, { ...task, branch: null }, 's-author', 1, false)).toThrow('branch');
    expect(() => authorRevise(db, { ...task, author_session_id: null }, 1)).toThrow('author session');
    expect(() => authorSync(db, { ...task, author_session_id: null }, 'main', 1)).toThrow('author session');
    expect(() => reviewStart(db, { ...task, base_commit: null }, conversation, 1)).toThrow('base commit');
    expect(() => reviewStart(db, { ...task, head_commit: null }, conversation, 1)).toThrow('head commit');
    expect(() => reviewRereview(db, { ...task, last_reviewed_commit: null }, conversation, 1, 'Summary', 'revision'))
      .toThrow('last reviewed commit');
  });

  it('validates commits, estimates, round and task tags with the shared protocol schemas', () => {
    expect(() => reviewStart(db, { ...task, head_commit: 'invalid' }, conversation, 1)).toThrow();
    expect(() => reviewStart(db, { ...task, review_round: 0 }, conversation, 1)).toThrow();
    expect(() => authorSync(db, task, 'main', -1)).toThrow();
    expect(() => authorStart(db, { ...task, tags: '[12]' }, 's-author', 1, false)).toThrow();
    expect(() => authorStart(db, task, '', 1, false)).toThrow();
  });

  it('rejects issue records and author responses that do not match protocol enums', () => {
    const row = issue('I1', { severity: 'unknown' });
    expect(() => authorStart(db, task, 's-author', 1, false)).toThrow();
    expect(() => authorRevise(db, task, 1)).toThrow();
    expect(() => reviewStart(db, task, conversation, 1)).toThrow();
    db.issues.update(row.id, { severity: 'blocking', author_response: 'unknown' });
    expect(() => reviewRereview(db, task, conversation, 1, 'Summary', 'revision')).toThrow();
  });

  it('rejects conversation records from another task', () => {
    const otherConversation = { ...conversation, task_id: task.id + 1 };
    expect(() => reviewStart(db, task, otherConversation, 1)).toThrow('another task');
    expect(() => reviewRereview(db, task, otherConversation, 1, 'Summary', 'revision')).toThrow('another task');
  });
});
