import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseNodeConfig,
  type Command,
  type Event,
  type IssueBrief,
  type NodeConfig,
  type TaskBrief,
} from '@quorum/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { AdapterError, type AgentAdapter } from '../../src/adapters/types.js';
import { createAdapter } from '../../src/adapters/index.js';
import { git } from '../../src/git/git.js';
import { openJournal, type NodeJournal } from '../../src/journal.js';
import { CommandRunner } from '../../src/runner/command-runner.js';
import { LeaderClient } from '../../src/ws/leader-client.js';
import { createTempRepo, type TempRepo } from '../helpers/temp-repo.js';
import { FakeLeader, type FakeLeaderConnection, welcomeFrame } from '../helpers/fake-leader.js';

interface RunnerFixture {
  repo: TempRepo;
  leader: FakeLeader;
  connection: FakeLeaderConnection;
  config: NodeConfig;
  journal: NodeJournal;
  runner: CommandRunner;
  client: LeaderClient;
  dispose(): Promise<void>;
}

const fixtures: RunnerFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

describe('CommandRunner', { timeout: 20_000 }, () => {
  it('streams mock events through the Leader client across author turns', async () => {
    const fixture = await createFixture({ author: [{ match: { any: true }, turns: [
      { writeFiles: { 'stream.txt': 'saved' }, reply: { status: 'done', summary: 'streamed' } },
    ] }] }, { transcripts: true });
    await openSession(fixture, 'open', 'sid-stream', 'author');
    const task = taskBrief(91, 'Streaming');
    const command: Command = { type: 'author.start', sid: 'sid-stream', taskId: task.id, task, branch: 'quorum/task-91', continueExisting: false, issues: [], estimated: 1 };
    await sendCommand(fixture.connection, 'stream', command);
    const first = await fixture.connection.next('transcript');
    expect(first).toMatchObject({ sid: 'sid-stream', taskId: 91 });
    expect(first.events.map((event) => event.kind)).toEqual(['status', 'tool_call', 'tool_result', 'text']);
    expect(first.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(first.events.every((event) => event.at > 0)).toBe(true);
    await nextEvent(fixture.connection, (event) => event.type === 'author.submitted');
    await sendCommand(fixture.connection, 'stream-again', { ...command, continueExisting: true });
    const second = await fixture.connection.next('transcript', (frame) => frame.msgId !== first.msgId);
    expect(second.events.map((event) => event.seq)).toEqual([5, 6, 7, 8]);
    await nextEvent(fixture.connection, (event) => event.type === 'author.submitted' && event.inReplyTo === 'stream-again');
  });

  it.each(['codex', 'pi'] as const)('restores and rejects %s author commits even if adapter throws', async (adapterType) => {
    let beforeHead = '';
    let beforeBranch = '';
    const fixture = await createFixture({ author: [{ match: { any: true }, turns: [{ reply: { status: 'done', summary: 'unused' } }] }] }, {
      adapterType,
      wrapAdapter(adapter) {
        return { ...adapter, async runTurn(opts) {
          beforeHead = (await git(opts.cwd, ['rev-parse', 'HEAD'])).stdout.trim();
          beforeBranch = (await git(opts.cwd, ['branch', '--show-current'])).stdout.trim();
          await writeFile(join(opts.cwd, 'unauthorized.txt'), 'agent commit');
          expect((await git(opts.cwd, ['add', '-A'])).code).toBe(0);
          expect((await git(opts.cwd, ['-c', 'user.name=Agent', '-c', 'user.email=agent@example.invalid', 'commit', '-m', 'unauthorized'])).code).toBe(0);
          if (adapterType === 'pi') throw new AdapterError('ADAPTER_ERROR', 'agent failed after commit');
          return adapter.runTurn(opts);
        } };
      },
    });
    await openSession(fixture, 'open', 'sid-guard', 'author');
    const task = taskBrief(92, 'Guard commit');
    await sendCommand(fixture.connection, 'guard', { type: 'author.start', sid: 'sid-guard', taskId: task.id, task, branch: 'quorum/task-92', continueExisting: false, issues: [], estimated: 1 });
    const failed = await nextEvent(fixture.connection, (event) => event.type === 'turn.failed');
    expect(failed).toMatchObject({ code: 'GIT_ERROR', message: expect.stringContaining('Agent changed git HEAD or branch') });
    const cwd = fixture.journal.getSession('sid-guard')!.worktree;
    expect((await git(cwd, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(beforeHead);
    expect((await git(cwd, ['branch', '--show-current'])).stdout.trim()).toBe(beforeBranch);
    expect((await git(cwd, ['status', '--porcelain'])).stdout).toBe('');
    await expect(access(join(cwd, 'unauthorized.txt'))).rejects.toThrow();
    expect((await git(cwd, ['rev-parse', 'origin/quorum/task-92'])).stdout.trim()).toBe(beforeHead);
  });

  it('detects a branch switch at unchanged HEAD and leaves the switched-to branch intact', async () => {
    let beforeHead = '';
    const fixture = await createFixture({}, {
      adapterType: 'pi',
      wrapAdapter(adapter) {
        return { ...adapter, async runTurn(opts) {
          beforeHead = (await git(opts.cwd, ['rev-parse', 'HEAD'])).stdout.trim();
          expect((await git(opts.cwd, ['checkout', '-b', 'agent-other-branch'])).code).toBe(0);
          await writeFile(join(opts.cwd, 'untracked.txt'), 'discard');
          return { nativeId: 'native', text: 'unused', usage: { inputTokens: 0, outputTokens: 0 }, contextTokens: 0 };
        } };
      },
    });
    await openSession(fixture, 'open', 'sid-switch', 'author');
    const task = taskBrief(93, 'Guard branch');
    await sendCommand(fixture.connection, 'switch', { type: 'author.start', sid: 'sid-switch', taskId: task.id, task, branch: 'quorum/task-93', continueExisting: false, issues: [], estimated: 1 });
    expect(await nextEvent(fixture.connection, (event) => event.type === 'turn.failed')).toMatchObject({ code: 'GIT_ERROR' });
    const cwd = fixture.journal.getSession('sid-switch')!.worktree;
    expect((await git(cwd, ['branch', '--show-current'])).stdout.trim()).toBe('quorum/task-93');
    expect((await git(cwd, ['rev-parse', 'agent-other-branch'])).stdout.trim()).toBe(beforeHead);
    await expect(access(join(cwd, 'untracked.txt'))).rejects.toThrow();
  });

  it('redacts home paths and caps adapter failure messages before they leave the Node', async () => {
    const home = homedir();
    const fixture = await createFixture({}, {
      wrapAdapter(adapter) {
        return { ...adapter, async runTurn() {
          throw new AdapterError('ADAPTER_ERROR', `failed reading ${home}/.codex/auth.json ${'x'.repeat(3000)}`);
        } };
      },
    });
    await openSession(fixture, 'open', 'sid-redact', 'author');
    const task = taskBrief(95, 'Redact failure');
    await sendCommand(fixture.connection, 'redact', {
      type: 'author.start', sid: 'sid-redact', taskId: task.id, task, branch: 'quorum/task-95', continueExisting: false, issues: [], estimated: 1,
    });
    const failed = await nextEvent(fixture.connection, (event) => event.type === 'turn.failed');
    expect(failed.type).toBe('turn.failed');
    if (failed.type !== 'turn.failed') return;
    expect(failed.code).toBe('ADAPTER_ERROR');
    expect(failed.message).not.toContain(home);
    expect(failed.message).toContain('~/.codex/auth.json');
    expect(failed.message.length).toBeLessThanOrEqual(2048);
  });

  it('allows sandboxed author file edits and leaves committing to Quorum', async () => {
    const fixture = await createFixture({ author: [{ match: { any: true }, turns: [{
      writeFiles: { 'allowed.txt': 'normal edit' }, reply: { status: 'done', summary: 'normal edits' },
    }] }] }, { adapterType: 'codex' });
    await openSession(fixture, 'open', 'sid-allowed', 'author');
    const task = taskBrief(94, 'Normal edit');
    await sendCommand(fixture.connection, 'normal', { type: 'author.start', sid: 'sid-allowed', taskId: task.id, task, branch: 'quorum/task-94', continueExisting: false, issues: [], estimated: 1 });
    expect(await nextEvent(fixture.connection, (event) => event.type === 'author.submitted')).toMatchObject({ summary: 'normal edits', filesChanged: ['allowed.txt'] });
  });

  it('restores directive commits and untracked edits before completing read-only work', async () => {
    let beforeHead = '';
    const fixture = await createFixture({}, {
      adapterType: 'pi',
      wrapAdapter(adapter) {
        return { ...adapter, async runTurn(opts) {
          beforeHead = (await git(opts.cwd, ['rev-parse', 'HEAD'])).stdout.trim();
          await writeFile(join(opts.cwd, 'readonly.txt'), 'unexpected write');
          expect((await git(opts.cwd, ['add', '-A'])).code).toBe(0);
          expect((await git(opts.cwd, ['-c', 'user.name=Agent', '-c', 'user.email=agent@example.invalid', 'commit', '-m', 'unexpected'])).code).toBe(0);
          await writeFile(join(opts.cwd, 'untracked.txt'), 'unexpected file');
          return { nativeId: 'native', text: '```quorum-json\n{"answer":"answer"}\n```', usage: { inputTokens: 0, outputTokens: 0 }, contextTokens: 0 };
        } };
      },
    });
    await openSession(fixture, 'open', 'sid-readonly', 'directive');
    await sendCommand(fixture.connection, 'directive', { type: 'directive.run', sid: 'sid-readonly', directiveId: 'd', requester: 'Alice', text: 'Read only', estimated: 1 });
    expect(await nextEvent(fixture.connection, (event) => event.type === 'directive.completed')).toMatchObject({ text: 'answer' });
    const cwd = fixture.journal.getSession('sid-readonly')!.worktree;
    expect((await git(cwd, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(beforeHead);
    expect((await git(cwd, ['status', '--porcelain'])).stdout).toBe('');
    await expect(access(join(cwd, 'readonly.txt'))).rejects.toThrow();
    await expect(access(join(cwd, 'untracked.txt'))).rejects.toThrow();
  });
  it('moves an idle task branch off its lost session worktree before resuming in a replacement session', async () => {
    const fixture = await createFixture({
      author: [{ match: { any: true }, turns: [
        { writeFiles: { 'src/recovered.txt': 'first turn\n' }, reply: { status: 'done', summary: 'first turn' } },
        { reply: { status: 'done', summary: 'resumed turn' } },
      ] }],
    });
    const task = taskBrief(84, 'Resume an existing branch');
    await openSession(fixture, 'open-author-before-reconnect', 'sid-before-reconnect', 'author');
    await sendCommand(fixture.connection, 'author-before-reconnect', {
      type: 'author.start', sid: 'sid-before-reconnect', taskId: task.id, task,
      branch: 'quorum/task-84', continueExisting: false, issues: [], estimated: 100,
    });
    await nextEvent(fixture.connection, (event) => event.type === 'author.checkpoint');
    const first = await nextEvent(fixture.connection, (event) => event.type === 'author.submitted');
    expect(first).toMatchObject({ type: 'author.submitted', status: 'done', summary: 'first turn' });

    await openSession(fixture, 'open-author-after-reconnect', 'sid-after-reconnect', 'author');
    await sendCommand(fixture.connection, 'author-after-reconnect', {
      type: 'author.start', sid: 'sid-after-reconnect', taskId: task.id, task,
      branch: 'quorum/task-84', continueExisting: true, issues: [], estimated: 100,
    });
    await nextEvent(fixture.connection, (event) => event.type === 'author.checkpoint');
    const resumed = await nextEvent(fixture.connection, (event) => event.type === 'author.submitted');
    expect(resumed).toMatchObject({ type: 'author.submitted', status: 'done', summary: 'first turn' });

    const oldBranch = await git(join(fixture.repo.config.workspaceDir, 'worktrees', 'sid-before-reconnect'), ['branch', '--show-current']);
    expect(oldBranch.stdout.trim()).toBe('');
  }, 15_000);

  it('runs open, author start/revise, review/rereview, directive, and close commands', async () => {
    const fixture = await createFixture({
      author: [{
        match: { taskTitleContains: 'Greeting' },
        turns: [
          { rawReply: 'malformed first attempt', tokensPerTurn: { input: 2, output: 1 } },
          { writeFiles: { 'src/hello.txt': 'hello\n' }, reply: { status: 'done', summary: 'added greeting' }, tokensPerTurn: { input: 3, output: 2 } },
          { reply: { status: 'done', summary: 'fixed review issue', responses: [{ issue: 'I1', action: 'fixed', note: 'updated the greeting' }] } },
        ],
      }],
      reviewer: [{
        match: { any: true },
        turns: [
          { reply: { verdict: 'request_changes', summary: 'one issue', previousIssues: [], newIssues: [
            { severity: 'blocking', file: 'src/hello.txt', line: 1, comment: 'Handle the requested name.' },
          ] } },
          { reply: { verdict: 'approve', summary: 'fixed', previousIssues: [{ issue: 'I1', status: 'resolved' }], newIssues: [] } },
        ],
      }],
      directive: [{ match: { any: true }, turns: [{ reply: { answer: 'The greeting helper is in src/hello.txt.' } }] }],
    });
    const task = taskBrief(31, 'Greeting helper');

    await openSession(fixture, 'open-author', 'sid-author', 'author');
    const authorCommand: Command = {
      type: 'author.start', sid: 'sid-author', taskId: task.id, task, branch: 'quorum/task-31',
      continueExisting: false, issues: [], estimated: 100,
    };
    await sendCommand(fixture.connection, 'author-start', authorCommand);
    const checkpointOne = await nextEvent(fixture.connection, (event) => event.type === 'author.checkpoint');
    const checkpointTwo = await nextEvent(fixture.connection, (event) => event.type === 'author.checkpoint');
    const submitted = await nextEvent(fixture.connection, (event) => event.type === 'author.submitted' && event.inReplyTo === 'author-start');
    expect(checkpointOne.type).toBe('author.checkpoint');
    expect(checkpointTwo.type).toBe('author.checkpoint');
    expect(submitted).toMatchObject({
      type: 'author.submitted', status: 'done', summary: 'added greeting', responses: [],
      filesChanged: ['src/hello.txt'], diffLines: 1, tests: { passed: true },
      usage: { inputTokens: 5, outputTokens: 3, contextTokens: 5 },
    });
    if (submitted.type !== 'author.submitted') throw new Error('expected author.submitted');

    await openSession(fixture, 'open-reviewer', 'sid-reviewer', 'reviewer');
    const startReview: Command = {
      type: 'review.start', sid: 'sid-reviewer', taskId: task.id, conversationId: 'conversation-31', round: 1,
      task, branch: 'quorum/task-31', baseCommit: submitted.baseCommit, headCommit: submitted.headCommit,
      testSummary: 'passed', priorIssues: [], estimated: 100,
    };
    await sendCommand(fixture.connection, 'review-start', startReview);
    const reviewed = await nextEvent(fixture.connection, (event) => event.type === 'review.completed' && event.inReplyTo === 'review-start');
    expect(reviewed).toMatchObject({ type: 'review.completed', output: { verdict: 'request_changes' } });

    const issue: IssueBrief = {
      code: 'I1', severity: 'blocking', source: 'reviewer', file: 'src/hello.txt', line: 1,
      comment: 'Handle the requested name.',
    };
    const revise: Command = {
      type: 'author.revise', sid: 'sid-author', taskId: task.id, conversationId: 'conversation-31', round: 2,
      task, branch: 'quorum/task-31', openIssues: [issue], suggestions: [], testFailure: null, estimated: 100,
    };
    await sendCommand(fixture.connection, 'author-revise', revise);
    const revised = await nextEvent(fixture.connection, (event) => event.type === 'author.submitted' && event.inReplyTo === 'author-revise');
    expect(revised).toMatchObject({ type: 'author.submitted', status: 'done', responses: [{ issue: 'I1', action: 'fixed' }] });
    if (revised.type !== 'author.submitted') throw new Error('expected author.submitted');

    const rereview: Command = {
      type: 'review.rereview', sid: 'sid-reviewer', taskId: task.id, conversationId: 'conversation-31', round: 2,
      task, fromCommit: submitted.headCommit, headCommit: revised.headCommit, baseCommit: submitted.baseCommit,
      openIssues: [{ ...issue, authorResponse: 'fixed', authorNote: 'updated the greeting' }],
      authorSummary: 'fixed requested name support', reason: 'revision', estimated: 100,
    };
    await sendCommand(fixture.connection, 'review-rereview', rereview);
    const rereviewed = await nextEvent(fixture.connection, (event) => event.type === 'review.completed' && event.inReplyTo === 'review-rereview');
    expect(rereviewed).toMatchObject({ type: 'review.completed', output: { verdict: 'approve' } });

    await openSession(fixture, 'open-directive', 'sid-directive', 'directive');
    const directive: Command = {
      type: 'directive.run', sid: 'sid-directive', directiveId: 'directive-31', requester: 'Bob',
      text: 'Where is the greeting helper?', estimated: 50,
    };
    await sendCommand(fixture.connection, 'directive-run', directive);
    expect(await nextEvent(fixture.connection, (event) => event.type === 'directive.completed'))
      .toMatchObject({ type: 'directive.completed', directiveId: 'directive-31', text: expect.stringContaining('src/hello.txt') });

    await closeSession(fixture, 'close-author', 'sid-author');
    await closeSession(fixture, 'close-reviewer', 'sid-reviewer');
    await closeSession(fixture, 'close-directive', 'sid-directive');
    await expect(access(join(fixture.repo.config.workspaceDir, 'worktrees', 'sid-author'))).rejects.toThrow();
  });

  it('syncs a real merge conflict, then cancels an active turn and releases its worktree', async () => {
    let cancelTurnStarted!: () => void;
    const cancelStarted = new Promise<void>((resolve) => { cancelTurnStarted = resolve; });
    let reviseCount = 0;
    const fixture = await createFixture({
      author: [
        {
          match: { taskTitleContains: 'Conflict' },
          turns: [
            { writeFiles: { 'conflict.txt': 'author version\n' }, reply: { status: 'done', summary: 'started conflict task' } },
            { reply: { status: 'done', summary: 'responded', responses: [{ issue: 'I1', action: 'fixed', note: 'handled' }] } },
            { delayMs: 5000, reply: { status: 'done', summary: 'cancel me', responses: [{ issue: 'I1', action: 'fixed', note: 'handled' }] } },
          ],
        },
        { match: { any: true }, turns: [{ writeFiles: { 'conflict.txt': 'both sides retained\n' }, reply: { status: 'done', summary: 'resolved merge' } }] },
      ],
    }, {
      wrapAdapter(adapter) {
        return {
          createSession: (opts) => adapter.createSession(opts),
          closeSession: (nativeId) => adapter.closeSession(nativeId),
          runTurn: (opts) => {
            if (opts.prompt.includes('revision round')) {
              reviseCount += 1;
              if (reviseCount === 2) {
                cancelTurnStarted();
                return new Promise((_resolve, reject) => {
                  const onAbort = () => {
                    opts.signal.removeEventListener('abort', onAbort);
                    reject(new AdapterError('CANCELLED', 'cancelled by the test'));
                  };
                  opts.signal.addEventListener('abort', onAbort, { once: true });
                });
              }
            }
            return adapter.runTurn(opts);
          },
        };
      },
    });
    const task = taskBrief(42, 'Conflict resolution');
    await openSession(fixture, 'open-author', 'sid-author', 'author');
    const start: Command = {
      type: 'author.start', sid: 'sid-author', taskId: task.id, task, branch: 'quorum/task-42',
      continueExisting: false, issues: [], estimated: 100,
    };
    await sendCommand(fixture.connection, 'author-start', start);
    await nextEvent(fixture.connection, (event) => event.type === 'author.checkpoint');
    const submitted = await nextEvent(fixture.connection, (event) => event.type === 'author.submitted');
    if (submitted.type !== 'author.submitted') throw new Error('expected author.submitted');

    const blockingIssue: IssueBrief = {
      code: 'I1', severity: 'blocking', source: 'reviewer', file: 'conflict.txt', line: 1, comment: 'Keep the main change too.',
    };
    await sendCommand(fixture.connection, 'author-revise', {
      type: 'author.revise', sid: 'sid-author', taskId: task.id, conversationId: null, round: 1,
      task, branch: 'quorum/task-42', openIssues: [blockingIssue], suggestions: [], testFailure: null, estimated: 100,
    });
    await nextEvent(fixture.connection, (event) => event.type === 'author.checkpoint');
    await nextEvent(fixture.connection, (event) => event.type === 'author.submitted' && event.inReplyTo === 'author-revise');

    await writeFile(join(fixture.repo.seedPath, 'conflict.txt'), 'main version\n');
    expect((await git(fixture.repo.seedPath, ['add', 'conflict.txt'])).code).toBe(0);
    expect((await git(fixture.repo.seedPath, ['commit', '-m', 'advance main with conflict'])).code).toBe(0);
    expect((await git(fixture.repo.seedPath, ['push', 'origin', 'main'])).code).toBe(0);
    await sendCommand(fixture.connection, 'author-sync', {
      type: 'author.sync', sid: 'sid-author', taskId: task.id, branch: 'quorum/task-42', mainBranch: 'main', estimated: 100,
    });
    await nextEvent(fixture.connection, (event) => event.type === 'author.checkpoint');
    const synced = await nextEvent(fixture.connection, (event) => event.type === 'author.synced');
    expect(synced).toMatchObject({ type: 'author.synced', hadConflicts: true, tests: { passed: true } });

    const cancelRevise: Command = {
      type: 'author.revise', sid: 'sid-author', taskId: task.id, conversationId: null, round: 2,
      task, branch: 'quorum/task-42', openIssues: [blockingIssue], suggestions: [], testFailure: null, estimated: 100,
    };
    fixture.connection.send({ kind: 'cmd', msgId: 'author-revise-cancel', cmd: cancelRevise });
    await fixture.connection.next('ack', (frame) => frame.msgId === 'author-revise-cancel');
    await cancelStarted;
    fixture.connection.send({
      kind: 'cmd', msgId: 'task-cancel', cmd: { type: 'task.cancel', sid: 'sid-author', taskId: task.id },
    });
    await fixture.connection.next('ack', (frame) => frame.msgId === 'task-cancel');
    const cancelled = await nextEvent(fixture.connection, (event) => event.type === 'turn.failed' && event.inReplyTo === 'author-revise-cancel');
    expect(cancelled).toMatchObject({ type: 'turn.failed', code: 'CANCELLED', taskId: task.id });
    await waitFor(() => fixture.journal.getCommand('task-cancel')?.state === 'done');
    const worktree = join(fixture.repo.config.workspaceDir, 'worktrees', 'sid-author');
    expect((await git(worktree, ['status', '--porcelain'])).stdout).toBe('');
    expect((await git(worktree, ['branch', '--show-current'])).stdout.trim()).toBe('');
  });

  it('compacts context before a turn, sums usage, and maps adapter timeouts', async () => {
    const fixture = await createFixture({
      author: [{
        match: { taskTitleContains: 'Compact' },
        turns: [
          { tokensPerTurn: { input: 60, output: 2 }, reply: { status: 'done', summary: 'initial' } },
          { tokensPerTurn: { input: 10, output: 3 }, reply: { status: 'done', summary: 'revised', responses: [] } },
        ],
      }],
      directive: [{ match: { any: true }, turns: [{ delayMs: 5000, reply: { answer: 'too late' } }] }],
      behaviors: { tokensPerTurn: { input: 1, output: 1 } },
    }, { contextWindow: 100, contextPressurePct: 0.5, turnTimeoutSec: 1 });
    const task = taskBrief(53, 'Compact feature');
    await openSession(fixture, 'open-author', 'sid-author', 'author');
    await sendCommand(fixture.connection, 'author-start', {
      type: 'author.start', sid: 'sid-author', taskId: task.id, task, branch: 'quorum/task-53',
      continueExisting: false, issues: [], estimated: 100,
    });
    await nextEvent(fixture.connection, (event) => event.type === 'author.checkpoint');
    await nextEvent(fixture.connection, (event) => event.type === 'author.submitted');
    const oldNativeId = fixture.journal.getSession('sid-author')?.nativeId;

    await sendCommand(fixture.connection, 'author-revise', {
      type: 'author.revise', sid: 'sid-author', taskId: task.id, conversationId: null, round: 1,
      task, branch: 'quorum/task-53', openIssues: [], suggestions: [], testFailure: null, estimated: 100,
    });
    expect(await nextEvent(fixture.connection, (event) => event.type === 'session.compacted'))
      .toMatchObject({ type: 'session.compacted', contextTokensBefore: 60, contextTokensAfter: 1 });
    await nextEvent(fixture.connection, (event) => event.type === 'author.checkpoint');
    const revised = await nextEvent(fixture.connection, (event) => event.type === 'author.submitted' && event.inReplyTo === 'author-revise');
    expect(revised).toMatchObject({
      type: 'author.submitted', usage: { inputTokens: 12, outputTokens: 5, contextTokens: 11 },
    });
    expect(fixture.journal.getSession('sid-author')?.nativeId).not.toBe(oldNativeId);

    await openSession(fixture, 'open-directive', 'sid-directive', 'directive');
    await sendCommand(fixture.connection, 'directive-timeout', {
      type: 'directive.run', sid: 'sid-directive', directiveId: 'directive-timeout', requester: 'Alice', text: 'Wait.', estimated: 1,
    });
    expect(await nextEvent(fixture.connection, (event) => event.type === 'turn.failed' && event.inReplyTo === 'directive-timeout'))
      .toMatchObject({ type: 'turn.failed', code: 'TIMEOUT', directiveId: 'directive-timeout' });

    await openSession(fixture, 'open-git-session', 'sid-git', 'author');
    await sendCommand(fixture.connection, 'git-error', {
      type: 'author.sync', sid: 'sid-git', taskId: 54, branch: 'quorum/task-missing', mainBranch: 'main', estimated: 1,
    });
    expect(await nextEvent(fixture.connection, (event) => event.type === 'turn.failed' && event.inReplyTo === 'git-error'))
      .toMatchObject({ type: 'turn.failed', code: 'GIT_ERROR', taskId: 54 });
  });

  it('serializes commands per sid while running different sessions concurrently', async () => {
    const startOrder: string[] = [];
    const crossStarted = new Set<string>();
    let bothCrossTurns!: () => void;
    const bothStarted = new Promise<void>((resolve) => { bothCrossTurns = resolve; });
    const fixture = await createFixture({
      directive: [{ match: { any: true }, turns: [{ reply: { answer: 'done' } }] }],
    }, {
      wrapAdapter(adapter) {
        return {
          createSession: (opts) => adapter.createSession(opts),
          closeSession: (nativeId) => adapter.closeSession(nativeId),
          async runTurn(opts) {
            const id = /^QUORUM-DIRECTIVE:\s+(\S+)/m.exec(opts.prompt)?.[1] ?? '';
            if (id === 'same-1') await delay(100);
            startOrder.push(id);
            if (id === 'cross-1' || id === 'cross-2') {
              crossStarted.add(id);
              if (crossStarted.size === 2) bothCrossTurns();
            }
            return adapter.runTurn(opts);
          },
        };
      },
    });
    await openSession(fixture, 'open-one', 'sid-one', 'directive');
    await openSession(fixture, 'open-two', 'sid-two', 'directive');

    fixture.connection.send({ kind: 'cmd', msgId: 'same-1-msg', cmd: {
      type: 'directive.run', sid: 'sid-one', directiveId: 'same-1', requester: 'Alice', text: 'First.', estimated: 1,
    } });
    await fixture.connection.next('ack', (frame) => frame.msgId === 'same-1-msg');
    fixture.connection.send({ kind: 'cmd', msgId: 'same-2-msg', cmd: {
      type: 'directive.run', sid: 'sid-one', directiveId: 'same-2', requester: 'Alice', text: 'Second.', estimated: 1,
    } });
    await fixture.connection.next('ack', (frame) => frame.msgId === 'same-2-msg');
    await nextEvent(fixture.connection, (event) => event.type === 'directive.completed' && event.inReplyTo === 'same-1-msg');
    await nextEvent(fixture.connection, (event) => event.type === 'directive.completed' && event.inReplyTo === 'same-2-msg');
    expect(startOrder.slice(0, 2)).toEqual(['same-1', 'same-2']);

    fixture.connection.send({ kind: 'cmd', msgId: 'cross-1-msg', cmd: {
      type: 'directive.run', sid: 'sid-one', directiveId: 'cross-1', requester: 'Alice', text: 'One.', estimated: 1,
    } });
    fixture.connection.send({ kind: 'cmd', msgId: 'cross-2-msg', cmd: {
      type: 'directive.run', sid: 'sid-two', directiveId: 'cross-2', requester: 'Alice', text: 'Two.', estimated: 1,
    } });
    await Promise.all([
      fixture.connection.next('ack', (frame) => frame.msgId === 'cross-1-msg'),
      fixture.connection.next('ack', (frame) => frame.msgId === 'cross-2-msg'),
    ]);
    await Promise.race([bothStarted, delay(1500).then(() => { throw new Error('sessions did not run concurrently'); })]);
    expect(crossStarted).toEqual(new Set(['cross-1', 'cross-2']));
  });
});

async function createFixture(
  script: unknown,
  configPatch: {
    contextWindow?: number;
    contextPressurePct?: number;
    turnTimeoutSec?: number;
    wrapAdapter?: (adapter: AgentAdapter) => AgentAdapter;
    adapterType?: 'codex' | 'pi';
    transcripts?: boolean;
  } = {},
): Promise<RunnerFixture> {
  const repo = await createTempRepo();
  const leader = new FakeLeader();
  await leader.start();
  const tempDir = await mkdtemp(join(tmpdir(), 'quorum-node-runner-'));
  const scriptPath = join(tempDir, 'mock-script.json');
  await writeFile(scriptPath, JSON.stringify(script), 'utf8');
  const config = parseNodeConfig({
    leaderUrl: leader.url,
    agentId: 'agent-test',
    token: 'test-token',
    ownerName: 'Test Owner',
    repoRemoteUrl: repo.remotePath,
    workspaceDir: repo.config.workspaceDir,
    dataDir: join(tempDir, 'data'),
    gitIdentity: repo.config.gitIdentity,
    adapter: { type: 'mock', scriptPath, contextWindow: configPatch.contextWindow ?? 200000 },
    ...(configPatch.contextPressurePct === undefined ? {} : { contextPressurePct: configPatch.contextPressurePct }),
  });
  const journal = await openJournal(join(tempDir, 'journal'));
  const baseAdapter = await createAdapter(config.adapter);
  if (configPatch.adapterType !== undefined) config.adapter = { type: configPatch.adapterType, contextWindow: 200000 };
  const adapter = configPatch.wrapAdapter?.(baseAdapter) ?? baseAdapter;
  const clientRef: { current: LeaderClient | undefined } = { current: undefined };
  const runner = new CommandRunner({
    config,
    journal,
    adapter,
    enqueueEvent: (event) => {
      if (clientRef.current === undefined) throw new Error('Leader client is not initialized');
      return clientRef.current.enqueueEvent(event);
    },
    enqueueTranscript: (batch) => { clientRef.current?.enqueueTranscript(batch); },
    transcriptsEnabled: () => clientRef.current?.supportsTranscripts === true,
    mainBranch: () => 'main',
    turnTimeoutSec: () => configPatch.turnTimeoutSec ?? 5,
  });
  const client = new LeaderClient({
    config,
    journal,
    onCommand: (msgId, command) => runner.dispatch(msgId, command),
  });
  clientRef.current = client;
  client.start();
  const connection = await leader.waitForConnection();
  await connection.next('hello');
  connection.send(welcomeFrame({ turnTimeoutSec: configPatch.turnTimeoutSec ?? 5, ...(configPatch.transcripts ? { capabilities: ['transcript-v1'] } : {}) }));
  await connection.next('heartbeat');
  const fixture: RunnerFixture = {
    repo, leader, connection, config, journal, runner, client,
    async dispose() {
      await client.stop();
      await runner.drain();
      await leader.stop();
      journal.close();
      await repo.dispose();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
  fixtures.push(fixture);
  return fixture;
}

async function openSession(fixture: RunnerFixture, msgId: string, sid: string, profile: 'author' | 'reviewer' | 'directive'): Promise<void> {
  await sendCommand(fixture.connection, msgId, { type: 'session.open', sid, profile });
  expect(await nextEvent(fixture.connection, (event) => event.type === 'session.opened' && event.inReplyTo === msgId))
    .toMatchObject({ type: 'session.opened', ok: true, sid });
}

async function closeSession(fixture: RunnerFixture, msgId: string, sid: string): Promise<void> {
  await sendCommand(fixture.connection, msgId, { type: 'session.close', sid });
  expect(await nextEvent(fixture.connection, (event) => event.type === 'session.closed' && event.inReplyTo === msgId))
    .toMatchObject({ type: 'session.closed', sid });
}

async function sendCommand(connection: FakeLeaderConnection, msgId: string, command: Command): Promise<void> {
  connection.send({ kind: 'cmd', msgId, cmd: command });
  await connection.next('ack', (frame) => frame.msgId === msgId);
}

async function nextEvent(
  connection: FakeLeaderConnection,
  predicate: (event: Event) => boolean,
): Promise<Event> {
  const frame = await connection.next('evt', (candidate) => predicate(candidate.evt), 10_000);
  connection.send({ kind: 'ack', msgId: frame.msgId });
  return frame.evt;
}

function taskBrief(id: number, title: string): TaskBrief {
  return { id, title, description: `Implement ${title}.`, tags: [], requester: 'Test Owner' };
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Condition did not become true');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
