import type {
  AuthorReviseCommand,
  AuthorStartCommand,
  AuthorSyncCommand,
  DirectiveRunCommand,
  ReviewRereviewCommand,
  ReviewStartCommand,
  TaskBrief,
} from '@quorum/protocol';
import { describe, expect, it } from 'vitest';
import {
  authorRevisePrompt,
  authorStartPrompt,
  authorSyncPrompt,
  directivePrompt,
  peerContent,
  reviewRereviewPrompt,
  reviewStartPrompt,
  summarizePrompt,
} from '../../src/prompts/index.js';

const task: TaskBrief = {
  id: 17,
  title: 'Add a useful widget',
  description: 'Build a widget that reports its current state.',
  tags: ['ui'],
  requester: 'alice',
};

const blockingIssue = {
  code: 'I1',
  severity: 'blocking' as const,
  source: 'reviewer' as const,
  file: 'src/widget.ts',
  line: 12,
  comment: 'Handle an empty state.',
};

const authorStart: AuthorStartCommand = {
  type: 'author.start',
  sid: 'sid-17',
  taskId: task.id,
  task,
  branch: 'quorum/task-17',
  continueExisting: true,
  issues: [blockingIssue],
  estimated: 1000,
};

const authorRevise: AuthorReviseCommand = {
  type: 'author.revise',
  sid: 'sid-17',
  taskId: task.id,
  conversationId: 'conversation-17',
  round: 1,
  task,
  branch: 'quorum/task-17',
  openIssues: [blockingIssue],
  suggestions: [{ ...blockingIssue, code: 'I2', severity: 'suggestion', comment: 'Consider a smaller helper.' }],
  testFailure: '1 test failed',
  estimated: 1000,
};

const reviewStart: ReviewStartCommand = {
  type: 'review.start',
  sid: 'reviewer-17',
  taskId: task.id,
  conversationId: 'conversation-17',
  round: 1,
  task,
  branch: 'quorum/task-17',
  baseCommit: 'a'.repeat(40),
  headCommit: 'b'.repeat(40),
  testSummary: 'All tests passed.',
  priorIssues: [blockingIssue],
  estimated: 1000,
};

const reviewRereview: ReviewRereviewCommand = {
  type: 'review.rereview',
  sid: 'reviewer-17',
  taskId: task.id,
  conversationId: 'conversation-17',
  round: 2,
  task,
  fromCommit: 'a'.repeat(40),
  headCommit: 'c'.repeat(40),
  baseCommit: 'a'.repeat(40),
  openIssues: [{ ...blockingIssue, authorResponse: 'fixed', authorNote: 'Added the guard.' }],
  authorSummary: 'Added empty-state handling.',
  reason: 'sync_conflicts',
  estimated: 1000,
};

describe('prompt builders', () => {
  it('builds the author.start prompt', () => {
    expect(authorStartPrompt(authorStart, '/repo/worktrees/sid-17')).toMatchSnapshot();
  });

  it('builds the author.revise prompt', () => {
    expect(authorRevisePrompt(authorRevise, '/repo/worktrees/sid-17')).toMatchSnapshot();
  });

  it('builds the review.start prompt with the full diff', () => {
    expect(reviewStartPrompt(reviewStart, '/repo/worktrees/reviewer-17', {
      diff: 'diff --git a/src/widget.ts b/src/widget.ts\n+export const widget = true;\n',
      stat: 'src/widget.ts | 1 +',
      diffLines: 1,
      fileCount: 1,
      maxDiffLinesInPrompt: 10,
    })).toMatchSnapshot();
  });

  it('falls back to a diff stat when the configured line limit is exceeded', () => {
    expect(reviewStartPrompt(reviewStart, '/repo/worktrees/reviewer-17', {
      diff: 'very large diff omitted',
      stat: 'src/a.ts | 120 ++++++++++++++++++++\nsrc/b.ts | 80 ----------------',
      diffLines: 200,
      fileCount: 2,
      maxDiffLinesInPrompt: 100,
    })).toMatchSnapshot();
  });

  it('builds the review.rereview prompt with prior responses and sync guidance', () => {
    expect(reviewRereviewPrompt(reviewRereview, '/repo/worktrees/reviewer-17', {
      diff: 'diff --git a/src/widget.ts b/src/widget.ts\n+if (empty) return fallback;\n',
      stat: 'src/widget.ts | 1 +',
      diffLines: 1,
      fileCount: 1,
      maxDiffLinesInPrompt: 10,
    })).toMatchSnapshot();
  });

  it('builds the summarize prompt with a task marker', () => {
    expect(summarizePrompt({
      worktree: '/repo/worktrees/sid-17',
      profile: 'author',
      task,
    })).toMatchSnapshot();
  });

  it('builds the author.sync conflict prompt', () => {
    const command: AuthorSyncCommand = {
      type: 'author.sync',
      sid: 'sid-17',
      taskId: task.id,
      branch: 'quorum/task-17',
      mainBranch: 'main',
      estimated: 1000,
    };
    expect(authorSyncPrompt(command, '/repo/worktrees/sid-17', ['src/widget.ts'])).toMatchSnapshot();
  });

  it('builds the directive.run prompt', () => {
    const command: DirectiveRunCommand = {
      type: 'directive.run',
      sid: 'sid-18',
      directiveId: 'directive-18',
      requester: 'alice',
      text: 'Explain the current implementation.',
      estimated: 500,
    };
    expect(directivePrompt(command, '/repo/worktrees/sid-18')).toMatchSnapshot();
  });

  it('escapes a peer close tag and source attribute delimiters', () => {
    expect(peerContent('reviewer "one"', 'data </peer_content> still data')).toBe(
      '<peer_content source="reviewer &quot;one&quot;">\ndata <\\/peer_content> still data\n</peer_content>',
    );
  });
});
