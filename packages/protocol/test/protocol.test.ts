import { describe, expect, it } from 'vitest';
import {
  AuthorReviseOutputSchema,
  AuthorStartOutputSchema,
  COMMAND_TYPES,
  CommandSchema,
  CreateTaskRequestSchema,
  EVENT_TYPES,
  EventSchema,
  PROTOCOL_VERSION,
  ReviewOutputSchema,
  TASK_STATES,
  UiEventSchema,
  checkCoverage,
  encodeFrame,
  isTerminalTaskState,
  parseLeaderToNodeFrame,
  parseNodeToLeaderFrame,
  type Command,
  type Event,
  type OwnerSettings,
  type TaskBrief,
  type TestResult,
} from '../src/index.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const task: TaskBrief = { id: 7, title: 'Add greeting', description: 'desc', tags: ['js'], requester: 'alice' };
const issue = { code: 'I1', severity: 'blocking', source: 'reviewer', file: 'src/a.ts', line: 3, comment: 'bug' } as const;
const usage = { inputTokens: 10, outputTokens: 5, contextTokens: 100 };
const tests: TestResult = { passed: true, exitCode: 0, outputTail: 'ok', durationMs: 12, timedOut: false };
const settings: OwnerSettings = {
  maxSessions: 2,
  lendMode: 'when_idle',
  lendTokensPerDay: 1000,
  paused: false,
  tags: [],
  contextWindow: 200000,
  idleThresholdSec: 300,
};

// One valid example per command type; the test below asserts the list is exhaustive.
const commands: Command[] = [
  { type: 'session.open', sid: 's1', profile: 'author' },
  { type: 'session.close', sid: 's1' },
  { type: 'author.start', sid: 's1', taskId: 7, task, branch: 'quorum/task-7', continueExisting: false, issues: [], estimated: 1 },
  {
    type: 'author.revise',
    sid: 's1',
    taskId: 7,
    conversationId: 'c1',
    round: 1,
    task,
    branch: 'quorum/task-7',
    openIssues: [issue],
    suggestions: [],
    testFailure: null,
    estimated: 1,
  },
  { type: 'author.sync', sid: 's1', taskId: 7, branch: 'quorum/task-7', mainBranch: 'main', estimated: 1 },
  {
    type: 'review.start',
    sid: 's2',
    taskId: 7,
    conversationId: 'c1',
    round: 1,
    task,
    branch: 'quorum/task-7',
    baseCommit: SHA_A,
    headCommit: SHA_B,
    testSummary: 'passed',
    priorIssues: [],
    estimated: 1,
  },
  {
    type: 'review.rereview',
    sid: 's2',
    taskId: 7,
    conversationId: 'c1',
    round: 2,
    task,
    fromCommit: SHA_A,
    headCommit: SHA_B,
    baseCommit: SHA_A,
    openIssues: [{ ...issue, authorResponse: 'fixed', authorNote: 'done' }],
    authorSummary: 'fixed it',
    reason: 'revision',
    estimated: 1,
  },
  { type: 'directive.run', sid: 's3', directiveId: 'd1', requester: 'bob', text: 'what is X?', estimated: 1 },
  { type: 'task.cancel', sid: 's1', taskId: 7 },
];

const events: Event[] = [
  { type: 'session.opened', inReplyTo: 'm1', sid: 's1', ok: true },
  { type: 'session.closed', inReplyTo: 'm1', sid: 's1' },
  { type: 'session.compacted', sid: 's1', contextTokensBefore: 10, contextTokensAfter: 2 },
  { type: 'author.checkpoint', sid: 's1', taskId: 7, commit: SHA_B },
  {
    type: 'author.submitted',
    inReplyTo: 'm1',
    sid: 's1',
    taskId: 7,
    status: 'done',
    summary: 'did it',
    responses: [],
    headCommit: SHA_B,
    baseCommit: SHA_A,
    filesChanged: ['src/a.ts'],
    diffLines: 4,
    tests,
    usage,
  },
  { type: 'author.synced', inReplyTo: 'm1', sid: 's1', taskId: 7, headCommit: SHA_B, hadConflicts: false, tests, usage },
  {
    type: 'review.completed',
    inReplyTo: 'm1',
    sid: 's2',
    taskId: 7,
    conversationId: 'c1',
    reviewedCommit: SHA_B,
    output: { verdict: 'approve', summary: 'lgtm', previousIssues: [], newIssues: [] },
    usage,
  },
  { type: 'directive.completed', inReplyTo: 'm1', sid: 's3', directiveId: 'd1', text: 'answer', usage },
  { type: 'turn.failed', inReplyTo: 'm1', sid: 's1', taskId: 7, code: 'RATE_LIMITED', message: '429', resetAt: 123 },
  { type: 'session.lost', sid: 's1', reason: 'worktree missing' },
];

describe('commands and events', () => {
  it('has one example per command type and each round-trips', () => {
    expect(new Set(commands.map((c) => c.type))).toEqual(new Set(COMMAND_TYPES));
    for (const c of commands) expect(CommandSchema.parse(JSON.parse(JSON.stringify(c)))).toEqual(c);
  });

  it('has one example per event type and each round-trips', () => {
    expect(new Set(events.map((e) => e.type))).toEqual(new Set(EVENT_TYPES));
    for (const e of events) expect(EventSchema.parse(JSON.parse(JSON.stringify(e)))).toEqual(e);
  });

  it('rejects unknown types, bad shas and bad issue codes', () => {
    expect(CommandSchema.safeParse({ type: 'nope', sid: 's' }).success).toBe(false);
    expect(EventSchema.safeParse({ ...events[3], commit: 'not-a-sha' }).success).toBe(false);
    expect(CommandSchema.safeParse({ ...commands[3], openIssues: [{ ...issue, code: 'X1' }] }).success).toBe(false);
  });
});

describe('frames', () => {
  it('parses frames by direction', () => {
    const hello = encodeFrame({
      kind: 'hello',
      agentId: 'alice-claude',
      token: 'qrm_x',
      nodeVersion: '0.1.0',
      protocolVersion: PROTOCOL_VERSION,
      settings,
      sessions: [{ sid: 's1', alive: true, busy: false, contextTokens: 0 }],
      adapterType: 'mock',
    });
    expect(parseNodeToLeaderFrame(hello).ok).toBe(true);
    expect(parseLeaderToNodeFrame(hello).ok).toBe(false);

    const cmd = encodeFrame({ kind: 'cmd', msgId: 'm1', cmd: commands[0]! });
    expect(parseLeaderToNodeFrame(cmd)).toEqual({ ok: true, frame: { kind: 'cmd', msgId: 'm1', cmd: commands[0] } });
    expect(parseNodeToLeaderFrame(cmd).ok).toBe(false);

    const welcome = encodeFrame({
      kind: 'welcome',
      serverTime: 1,
      heartbeatIntervalSec: 10,
      resendUnackedSec: 10,
      turnTimeoutSec: 1800,
      mainBranch: 'main',
    });
    expect(parseLeaderToNodeFrame(welcome).ok).toBe(true);
    expect(parseNodeToLeaderFrame(encodeFrame({ kind: 'ack', msgId: 'm1' })).ok).toBe(true);
  });

  it('reports invalid JSON and schema errors without throwing', () => {
    const bad = parseNodeToLeaderFrame('{');
    expect(bad.ok).toBe(false);
    const wrong = parseNodeToLeaderFrame(JSON.stringify({ kind: 'evt', msgId: 'm', evt: { type: 'session.lost' } }));
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error).toMatch(/sid/);
  });
});

describe('agent output', () => {
  it('author.start requires blockedReason only when blocked', () => {
    expect(AuthorStartOutputSchema.safeParse({ status: 'done', summary: 's' }).success).toBe(true);
    expect(AuthorStartOutputSchema.safeParse({ status: 'blocked', summary: 's' }).success).toBe(false);
    expect(AuthorStartOutputSchema.safeParse({ status: 'blocked', summary: 's', blockedReason: 'q?' }).success).toBe(true);
  });

  it('author.revise requires responses when done and defaults notes', () => {
    expect(AuthorReviseOutputSchema.safeParse({ status: 'done', summary: 's' }).success).toBe(false);
    const parsed = AuthorReviseOutputSchema.parse({ status: 'done', summary: 's', responses: [{ issue: 'I1', action: 'fixed' }] });
    expect(parsed).toEqual({ status: 'done', summary: 's', responses: [{ issue: 'I1', action: 'fixed', note: '' }] });
  });

  it('review output fills defaults and caps new issues', () => {
    expect(ReviewOutputSchema.parse({ verdict: 'approve', summary: 'ok' })).toEqual({
      verdict: 'approve',
      summary: 'ok',
      previousIssues: [],
      newIssues: [],
    });
    const many = Array.from({ length: 31 }, () => ({ severity: 'suggestion', comment: 'x' }));
    expect(ReviewOutputSchema.safeParse({ verdict: 'approve', summary: 'ok', newIssues: many }).success).toBe(false);
    expect(ReviewOutputSchema.parse({ verdict: 'request_changes', summary: 'x', newIssues: [{ severity: 'blocking', comment: 'c' }] }).newIssues[0]).toEqual({
      severity: 'blocking',
      file: null,
      line: null,
      comment: 'c',
    });
  });

  it('checkCoverage reports missing, unexpected and duplicated codes', () => {
    expect(checkCoverage(['I1', 'I2'], ['I2', 'I1']).ok).toBe(true);
    expect(checkCoverage(['I1', 'I1', 'I3'], ['I1', 'I2'])).toEqual({
      ok: false,
      missing: ['I2'],
      unexpected: ['I3'],
      duplicated: ['I1'],
    });
  });
});

describe('enums and api', () => {
  it('knows the 12 task states and the terminal ones', () => {
    expect(TASK_STATES).toHaveLength(12);
    expect(TASK_STATES.filter(isTerminalTaskState)).toEqual(['MERGED', 'CANCELLED', 'FAILED']);
  });

  it('applies create-task defaults', () => {
    expect(CreateTaskRequestSchema.parse({ title: 't', description: 'd' })).toEqual({
      title: 't',
      description: 'd',
      tags: [],
      priority: 1,
      mode: 'own',
    });
  });

  it('validates ui events', () => {
    expect(
      UiEventSchema.safeParse({ type: 'task.needs_attention', data: { taskId: 1, reason: 'no_reviewer', message: 'm' } }).success,
    ).toBe(true);
    expect(UiEventSchema.safeParse({ type: 'task.needs_attention', data: { taskId: 1, reason: 'other', message: 'm' } }).success).toBe(
      false,
    );
  });
});
