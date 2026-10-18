import type { LeaderConfig } from '@quorum/protocol';
import type { LeaderDb, TaskRow } from '../db/repo.js';
import { LEADER_IDENTITY, runShell, type LeaderGit } from '../git/leader-git.js';
import { silentLogger, type Logger } from '../logging.js';
import type { EventHandlers } from './handlers.js';
import { requeueMerge, transition, transitionToAuthorState } from './state-machine.js';

// Spec §14.3: strictly serial squash merges into main. Only the Leader writes main (invariant §3.5).

const MERGE_BRANCH = 'quorum-merge';
/** Consecutive retryable failures (fetch/clone) before a task is escalated instead of requeued. */
export const MAX_RETRYABLE_MERGE_FAILURES = 5;
export const MERGE_RETRY_BASE_MS = 5_000;
export const MERGE_RETRY_MAX_MS = 2 * 60_000;

/** The remote could not be reached (fetch or clone failed); the task itself is not at fault. */
class RetryableMergeError extends Error {
  constructor(readonly original: unknown) {
    super(original instanceof Error ? original.message : String(original));
    this.name = 'RetryableMergeError';
  }
}

export interface MergeWorkerOptions {
  db: LeaderDb;
  config: LeaderConfig;
  git: LeaderGit;
  handlers: EventHandlers;
  now?: () => number;
  logger?: Logger;
  /** Test hook: runs right before `git push` (e.g. to simulate a concurrent push to main). */
  beforePush?: () => Promise<void>;
}

type Outcome =
  | { kind: 'merged'; commit: string }
  | { kind: 'conflict' }
  | { kind: 'tests_failed'; output: string }
  | { kind: 'push_rejected' }
  | { kind: 'aborted' };

export class MergeWorker {
  private running = false;
  private again = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly now: () => number;
  private readonly log: Logger;
  private idle: Promise<void> = Promise.resolve();
  private readonly failures = new Map<number, number>();
  private backoffUntil = 0;

  constructor(private readonly options: MergeWorkerOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.logger ?? silentLogger;
  }

  start(): void {
    this.timer = setInterval(() => this.kick(), this.options.config.scheduler.tickMs);
    this.timer.unref();
    this.kick();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.idle;
  }

  /** Starts draining the queue unless a drain is already running. */
  kick(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    this.idle = this.drain().catch((error: unknown) => this.log.error({ err: error }, 'merge queue drain failed')).finally(() => {
      this.running = false;
      if (this.again) {
        this.again = false;
        this.kick();
      }
    });
  }

  /** Resolves once the current drain (if any) finishes — for tests. */
  async settled(): Promise<void> {
    while (this.running) await this.idle;
  }

  private next(): TaskRow | undefined {
    const queued = this.options.db.mergeQueue.all().map((q) => this.options.db.tasks.require(q.task_id));
    return queued
      .filter((t) => t.state === 'MERGE_QUEUED')
      .sort((a, b) => (a.approved_at ?? 0) - (b.approved_at ?? 0) || a.id - b.id)[0];
  }

  private async drain(): Promise<void> {
    // While backing off the remote is likely down, so every queued task would fail the same way.
    for (let task = this.next(); task !== undefined && this.now() >= this.backoffUntil; task = this.next()) {
      const id = task.id;
      transition(this.options.db, id, 'MERGING', { reason: 'merge_started', actor: 'leader', at: this.now() });
      try {
        await this.mergeOne(id);
        this.failures.delete(id);
      } catch (error) {
        if (error instanceof RetryableMergeError) {
          this.retryLater(id, error);
          continue;
        }
        this.failures.delete(id);
        this.log.error({ err: error, taskId: id }, 'merge failed unexpectedly');
        this.whileMerging(id, () => this.options.handlers.escalate(id, 'merge_error'));
      }
    }
  }

  /** Puts the task back in the queue with exponential backoff, or escalates once the retry budget is spent. */
  private retryLater(taskId: number, error: RetryableMergeError): void {
    const failures = (this.failures.get(taskId) ?? 0) + 1;
    if (failures >= MAX_RETRYABLE_MERGE_FAILURES) {
      this.failures.delete(taskId);
      this.log.error({ err: error.original, taskId, failures }, 'merge failed repeatedly; escalating');
      this.whileMerging(taskId, () => this.options.handlers.escalate(taskId, 'merge_fetch_failed'));
      return;
    }
    this.failures.set(taskId, failures);
    const delay = Math.min(MERGE_RETRY_BASE_MS * 2 ** (failures - 1), MERGE_RETRY_MAX_MS);
    this.backoffUntil = this.now() + delay;
    this.log.warn({ err: error.original, taskId, failures, retryInMs: delay }, 'merge hit a transient git failure; requeued');
    this.whileMerging(taskId, () =>
      requeueMerge(this.options.db, taskId, { reason: 'merge_retry', actor: 'leader', data: { failures, error: error.message }, at: this.now() }),
    );
  }

  private async mergeOne(taskId: number): Promise<void> {
    const { config } = this.options;
    for (let attempt = 1; ; attempt += 1) {
      const outcome = await this.options.git.exclusive(() => this.attempt(taskId));
      this.log.info({ taskId, attempt, outcome: outcome.kind }, 'merge attempt');
      if (outcome.kind === 'push_rejected' && attempt < config.limits.maxMergePushRetries) continue;
      this.apply(taskId, outcome);
      return;
    }
  }

  private apply(taskId: number, outcome: Outcome): void {
    const { db, handlers, config } = this.options;
    switch (outcome.kind) {
      case 'aborted':
        return;
      case 'merged':
        this.whileMerging(taskId, () => {
          db.tasks.update(taskId, { merged_commit: outcome.commit });
          handlers.testsPassed(taskId);
          handlers.finishTask(taskId, 'MERGED', 'merged');
        });
        return;
      case 'conflict':
        this.whileMerging(taskId, () => {
          const task = db.tasks.require(taskId);
          if (task.sync_attempts >= config.limits.maxSyncAttempts) {
            handlers.escalate(taskId, 'sync_limit');
            return;
          }
          db.tasks.update(taskId, { sync_attempts: task.sync_attempts + 1 });
          const after = transitionToAuthorState(db, taskId, 'SYNCING', { reason: 'merge_conflict', actor: 'leader', at: this.now() });
          if (after.state === 'SYNCING') handlers.sendAuthor(taskId, 'sync');
        });
        return;
      case 'tests_failed':
        this.whileMerging(taskId, () => handlers.mergeTestsFailed(taskId, outcome.output));
        return;
      case 'push_rejected':
        this.whileMerging(taskId, () => handlers.escalate(taskId, 'merge_push_failed'));
        return;
    }
  }

  /** Applies an outcome only if nobody (e.g. a human cancel) moved the task out of MERGING meanwhile. */
  private whileMerging(taskId: number, fn: () => void): void {
    this.options.db.withTx(() => {
      if (this.options.db.tasks.require(taskId).state !== 'MERGING') return;
      fn();
    });
  }

  private async attempt(taskId: number): Promise<Outcome> {
    const task = this.options.db.tasks.require(taskId);
    if (task.state !== 'MERGING' || task.branch === null) return { kind: 'aborted' };
    try {
      await this.options.git.fetch();
    } catch (error) {
      throw new RetryableMergeError(error);
    }
    try {
      return await this.mergeAndPush(task);
    } finally {
      // Whatever happened (including a throw mid-merge), leave the clone clean for the next attempt.
      await this.reset();
    }
  }

  private async mergeAndPush(task: TaskRow): Promise<Outcome> {
    const { git, db, config } = this.options;
    const taskId = task.id;
    await git.must(['checkout', '-B', MERGE_BRANCH, git.mainRef]);
    await git.must(['reset', '--hard', git.mainRef]);
    await git.must(['clean', '-fd']);

    const squash = await git.run(['merge', '--squash', `origin/${task.branch}`]);
    if (squash.code !== 0) return { kind: 'conflict' };

    const project = await git.projectConfig();
    const setup = await git.setupIfNeeded(project);
    if (setup !== null && !setup.passed) return { kind: 'tests_failed', output: `setupCommand failed:\n${setup.outputTail}` };
    if (project.testCommand !== null) {
      const tests = await runShell(project.testCommand, git.clonePath, Math.min(project.testTimeoutSec, config.timeouts.mergeTestTimeoutSec) * 1000);
      if (!tests.passed) return { kind: 'tests_failed', output: tests.outputTail };
    }
    if (db.tasks.require(taskId).state !== 'MERGING') return { kind: 'aborted' };

    const staged = await git.run(['diff', '--cached', '--quiet']);
    if (staged.code === 0) {
      // The branch adds nothing on top of main (e.g. already merged): treat main as the result.
      return { kind: 'merged', commit: await git.revParse('HEAD') };
    }
    await git.must([...LEADER_IDENTITY, 'commit', '-m', this.commitMessage(task)]);
    await this.options.beforePush?.();
    const push = await git.run(['push', 'origin', `${MERGE_BRANCH}:${config.repo.mainBranch}`]);
    if (push.code !== 0) {
      this.log.warn({ taskId, stderr: push.stderr }, 'push to main rejected');
      return { kind: 'push_rejected' };
    }
    return { kind: 'merged', commit: await git.revParse('HEAD') };
  }

  private async reset(): Promise<void> {
    const { git } = this.options;
    await git.run(['merge', '--abort']);
    await git.run(['reset', '--hard', git.mainRef]);
    await git.run(['clean', '-fd']);
  }

  private commitMessage(task: TaskRow): string {
    const { db } = this.options;
    const reviewers = [...new Set(db.conversations.find({ task_id: task.id }).map((c) => c.reviewer_agent_id))];
    const requester = db.agents.require(task.requester_agent_id).owner_name;
    const trailers = [
      `Quorum-Task: ${task.id}`,
      ...(task.author_agent_id !== null ? [`Quorum-Author: ${task.author_agent_id}`] : []),
      ...reviewers.map((r) => `Quorum-Reviewer: ${r}`),
      `Requested-By: ${requester}`,
    ];
    return `${task.title} (quorum #${task.id})\n\n${trailers.join('\n')}\n`;
  }
}
