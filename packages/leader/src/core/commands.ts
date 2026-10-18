import {
  AuthorReviseCommandSchema,
  AuthorStartCommandSchema,
  AuthorSyncCommandSchema,
  IssueBriefSchema,
  OpenIssueWithResponseSchema,
  ReviewRereviewCommandSchema,
  ReviewStartCommandSchema,
  TaskBriefSchema,
  type CommandOf,
  type IssueBrief,
  type TaskBrief,
} from '@quorum/protocol';
import type { ConversationRow, IssueRow, LeaderDb, TaskRow } from '../db/repo.js';

function required(value: string | null, field: string): string {
  if (value === null || value.length === 0) throw new Error(`Task requires ${field}`);
  return value;
}

function taskBrief(db: LeaderDb, task: TaskRow): TaskBrief {
  const tags: unknown = JSON.parse(task.tags);
  return TaskBriefSchema.parse({
    id: task.id,
    title: task.title,
    description: task.description,
    tags,
    requester: db.agents.require(task.requester_agent_id).owner_name,
  });
}

function issueBrief(issue: IssueRow): IssueBrief {
  return IssueBriefSchema.parse({
    code: issue.code,
    severity: issue.severity,
    source: issue.source,
    file: issue.file,
    line: issue.line,
    comment: issue.comment,
  });
}

function checkConversation(task: TaskRow, conversation: ConversationRow): void {
  if (conversation.task_id !== task.id) throw new Error('Review conversation belongs to another task');
}

export function authorStart(
  db: LeaderDb,
  task: TaskRow,
  sid: string,
  estimated: number,
  continueExisting: boolean,
): CommandOf<'author.start'> {
  return AuthorStartCommandSchema.parse({
    type: 'author.start',
    sid,
    taskId: task.id,
    task: taskBrief(db, task),
    branch: required(task.branch, 'branch'),
    continueExisting,
    issues: db.issues.find({ task_id: task.id }).map(issueBrief),
    estimated,
  });
}

export function authorRevise(db: LeaderDb, task: TaskRow, estimated: number): CommandOf<'author.revise'> {
  const issues = db.issues.find({ task_id: task.id, status: 'open' }).map(issueBrief);
  const conversation = db.conversations.find({ task_id: task.id, state: 'active' })[0];
  return AuthorReviseCommandSchema.parse({
    type: 'author.revise',
    sid: required(task.author_session_id, 'author session'),
    taskId: task.id,
    conversationId: conversation?.id ?? null,
    round: task.review_round,
    task: taskBrief(db, task),
    branch: required(task.branch, 'branch'),
    openIssues: issues.filter((issue) => issue.severity === 'blocking'),
    suggestions: issues.filter((issue) => issue.severity === 'suggestion'),
    testFailure: task.last_test_output,
    estimated,
  });
}

export function authorSync(
  _db: LeaderDb,
  task: TaskRow,
  mainBranch: string,
  estimated: number,
): CommandOf<'author.sync'> {
  return AuthorSyncCommandSchema.parse({
    type: 'author.sync',
    sid: required(task.author_session_id, 'author session'),
    taskId: task.id,
    branch: required(task.branch, 'branch'),
    mainBranch,
    estimated,
  });
}

export function reviewStart(
  db: LeaderDb,
  task: TaskRow,
  conversation: ConversationRow,
  estimated: number,
): CommandOf<'review.start'> {
  checkConversation(task, conversation);
  return ReviewStartCommandSchema.parse({
    type: 'review.start',
    sid: conversation.reviewer_session_id,
    taskId: task.id,
    conversationId: conversation.id,
    round: task.review_round,
    task: taskBrief(db, task),
    branch: required(task.branch, 'branch'),
    baseCommit: required(task.base_commit, 'base commit'),
    headCommit: required(task.head_commit, 'head commit'),
    testSummary: task.last_test_output ?? '',
    // System test-failure issues are resolved by the Leader, never by reviewers.
    priorIssues: db.issues.find({ task_id: task.id, status: 'open' })
      .filter((issue) => issue.source !== 'system').map(issueBrief),
    estimated,
  });
}

export function reviewRereview(
  db: LeaderDb,
  task: TaskRow,
  conversation: ConversationRow,
  estimated: number,
  summary: string,
  reason: 'revision' | 'sync_conflicts',
): CommandOf<'review.rereview'> {
  checkConversation(task, conversation);
  return ReviewRereviewCommandSchema.parse({
    type: 'review.rereview',
    sid: conversation.reviewer_session_id,
    taskId: task.id,
    conversationId: conversation.id,
    round: task.review_round,
    task: taskBrief(db, task),
    fromCommit: required(task.last_reviewed_commit, 'last reviewed commit'),
    headCommit: required(task.head_commit, 'head commit'),
    baseCommit: required(task.base_commit, 'base commit'),
    openIssues: db.issues.find({ task_id: task.id, status: 'open' })
      .filter((issue) => issue.source !== 'system').map((issue) =>
      OpenIssueWithResponseSchema.parse({
        ...issueBrief(issue),
        authorResponse: issue.author_response,
        authorNote: issue.author_note,
      })),
    authorSummary: summary,
    reason,
    estimated,
  });
}
