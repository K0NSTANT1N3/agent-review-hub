import {
  type AuthorReviseCommand,
  type AuthorStartCommand,
  type AuthorSyncCommand,
  type Command,
  type DirectiveRunCommand,
  type Event,
  type NodeConfig,
  type ReviewRereviewCommand,
  type ReviewStartCommand,
  type TestResult,
  type Usage,
} from '@quorum/protocol';
import {
  AuthorReviseOutputSchema,
  AuthorStartOutputSchema,
  DirectiveOutputSchema,
  ReviewOutputSchema,
  SummarizeOutputSchema,
  SyncOutputSchema,
  type AuthorReviseOutput,
  type AuthorStartOutput,
  type DirectiveOutput,
  type ReviewOutput,
  type SummarizeOutput,
  type SyncOutput,
} from '@quorum/protocol/agent-output';
import {
  AdapterError,
  type AgentAdapter,
  type Profile,
  type TurnResult,
} from '../adapters/types.js';
import {
  assertGitSuccess,
  GitExecutionError,
  GitTimeoutError,
  git,
} from '../git/git.js';
import {
  ConflictResolutionError,
  commitAndPushAfterAuthorTurn,
  createWorktree,
  diffInfo,
  ensureCleanBeforeAuthorTurn,
  finishSync,
  prepareAuthorExistingBranch,
  prepareAuthorNewBranch,
  prepareReviewer,
  releaseWorktree,
  removeWorktree,
  resetIfReviewerModified,
  syncWithMain,
  type WorktreeConfig,
} from '../git/worktrees.js';
import { NodeJournal, type JournalSession } from '../journal.js';
import {
  authorRevisePrompt,
  authorStartPrompt,
  authorSyncPrompt,
  directiveMarker,
  directivePrompt,
  reviewRereviewPrompt,
  reviewStartPrompt,
  seedSessionPrompt,
  summarizePrompt,
  taskMarker,
  type ReviewDiff,
} from '../prompts/index.js';
import { parseOutput } from '../output/parse.js';
import { runSetupIfNeeded, runTests } from './tests.js';
import type { ZodType } from 'zod';
import { join } from 'node:path';

export interface CommandRunnerOptions {
  config: NodeConfig;
  journal: NodeJournal;
  adapter: AgentAdapter;
  enqueueEvent: (event: Event) => string;
  mainBranch: () => string;
  turnTimeoutSec: () => number;
  getContextWindow?: () => number;
  onError?: (error: Error) => void;
}

interface ActiveTurn {
  controller: AbortController;
  workKey: string;
}

class RunnerFailure extends Error {
  constructor(
    readonly code: 'INVALID_OUTPUT' | 'ADAPTER_ERROR' | 'TIMEOUT' | 'CANCELLED' | 'GIT_ERROR',
    message: string,
    readonly resetAt?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RunnerFailure';
  }
}

class UsageAccumulator {
  inputTokens = 0;
  outputTokens = 0;
  contextTokens = 0;
  private hasResult = false;

  add(result: TurnResult): void {
    this.inputTokens += result.usage.inputTokens;
    this.outputTokens += result.usage.outputTokens;
    this.contextTokens = result.contextTokens;
    this.hasResult = true;
  }

  value(fallbackContextTokens = 0): Usage {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      contextTokens: this.hasResult ? this.contextTokens : fallbackContextTokens,
    };
  }
}

/** Executes Leader commands in per-session FIFO order, with independent sessions running concurrently. */
export class CommandRunner {
  private readonly queues = new Map<string, Promise<string | null>>();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly cancelledWork = new Set<string>();
  private readonly cancelWorkByMessage = new Map<string, string | null>();
  private readonly cancelResultBySid = new Map<string, string>();

  constructor(private readonly options: CommandRunnerOptions) {}

  dispatch(msgId: string, command: Command): void {
    let cancelKey: string | null = null;
    if (command.type === 'task.cancel') {
      const active = this.activeTurns.get(command.sid);
      cancelKey = commandWorkKey(command) ?? active?.workKey ?? null;
      if (cancelKey !== null) this.cancelledWork.add(cancelKey);
      this.cancelWorkByMessage.set(msgId, cancelKey);
      if (active !== undefined && (cancelKey === null || active.workKey === cancelKey)) active.controller.abort();
    }

    const previous = this.queues.get(command.sid) ?? Promise.resolve(null);
    const next = previous
      .catch((error: unknown) => {
        this.reportError(error);
        return null;
      })
      .then(() => this.runCommand(msgId, command));
    this.queues.set(command.sid, next);
    void next.catch((error: unknown) => this.reportError(error)).finally(() => {
      if (this.queues.get(command.sid) === next) this.queues.delete(command.sid);
    });
  }

  /** Wait for all commands already dispatched to finish; useful during daemon shutdown. */
  async drain(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.catch(() => null)));
  }

  private async runCommand(msgId: string, command: Command): Promise<string | null> {
    try {
      this.options.journal.markRunning(msgId);
    } catch (error) {
      this.reportError(error);
      return null;
    }

    if (command.type === 'session.open') return this.openSession(msgId, command);
    if (command.type === 'session.close') return this.closeSession(msgId, command);
    if (command.type === 'task.cancel') return this.cancelSessionWork(msgId, command);

    const key = commandWorkKey(command);
    if (key !== null && this.cancelledWork.has(key)) {
      const eventId = this.finish(msgId, this.failureEvent(msgId, command, new RunnerFailure('CANCELLED', 'Command cancelled before it started.')));
      return eventId;
    }

    const controller = new AbortController();
    if (key !== null) this.activeTurns.set(command.sid, { controller, workKey: key });
    const usage = new UsageAccumulator();
    const session = this.options.journal.getSession(command.sid);
    if (session !== null) this.options.journal.updateSession(command.sid, { state: 'busy' });

    try {
      this.throwIfAborted(controller.signal);
      const event = await this.executeTurnCommand(msgId, command, controller.signal, usage);
      return this.finish(msgId, event);
    } catch (error) {
      const event = this.failureEvent(msgId, command, error, usage.value(session?.contextTokens ?? 0));
      const eventId = this.finish(msgId, event);
      if (controller.signal.aborted) this.cancelResultBySid.set(command.sid, eventId);
      return eventId;
    } finally {
      if (key !== null && this.activeTurns.get(command.sid)?.controller === controller) {
        this.activeTurns.delete(command.sid);
      }
      const current = this.options.journal.getSession(command.sid);
      if (current !== null && current.state === 'busy') this.options.journal.updateSession(command.sid, { state: 'idle' });
    }
  }

  private async openSession(
    msgId: string,
    command: Extract<Command, { type: 'session.open' }>,
  ): Promise<string> {
    let event: Event;
    let createdWorktree = false;
    let createdJournalSession = false;
    try {
      if (this.options.journal.getSession(command.sid) !== null) {
        throw new Error(`Session ${command.sid} is already open in the Node journal.`);
      }
      const config = this.worktreeConfig();
      const worktree = await createWorktree(config, command.sid);
      createdWorktree = true;
      this.options.journal.createSession({
        sid: command.sid,
        nativeId: null,
        worktree,
        profile: command.profile,
        contextTokens: 0,
        state: 'opening',
      });
      createdJournalSession = true;
      await runSetupIfNeeded(worktree, config.mainBranch);
      const native = await this.options.adapter.createSession({ cwd: worktree, profile: command.profile });
      this.options.journal.updateSession(command.sid, { nativeId: native.nativeId, state: 'idle' });
      event = { type: 'session.opened', inReplyTo: msgId, sid: command.sid, ok: true };
    } catch (error) {
      if (createdJournalSession) this.options.journal.deleteSession(command.sid);
      if (createdWorktree) await this.tryRemoveWorktree(command.sid);
      event = {
        type: 'session.opened',
        inReplyTo: msgId,
        sid: command.sid,
        ok: false,
        error: errorMessage(error),
      };
    }
    return this.finish(msgId, event);
  }

  private async closeSession(
    msgId: string,
    command: Extract<Command, { type: 'session.close' }>,
  ): Promise<string> {
    const session = this.options.journal.getSession(command.sid);
    if (session === null) return this.finish(msgId, { type: 'session.closed', inReplyTo: msgId, sid: command.sid });
    try {
      if (session.nativeId !== null) await this.options.adapter.closeSession(session.nativeId);
      await removeWorktree(this.worktreeConfig(), command.sid);
      this.options.journal.deleteSession(command.sid);
      return this.finish(msgId, { type: 'session.closed', inReplyTo: msgId, sid: command.sid });
    } catch (error) {
      this.options.journal.updateSession(command.sid, { state: 'lost' });
      return this.finish(msgId, { type: 'session.lost', sid: command.sid, reason: errorMessage(error) });
    }
  }

  private async cancelSessionWork(
    msgId: string,
    command: Extract<Command, { type: 'task.cancel' }>,
  ): Promise<string> {
    try {
      if (this.options.journal.getSession(command.sid) !== null) {
        const fetched = await git(this.worktree(command.sid), ['fetch', 'origin', '--prune']);
        assertGitSuccess(fetched, 'fetch before releasing cancelled session');
        await releaseWorktree(this.worktreeConfig(), command.sid);
        this.options.journal.updateSession(command.sid, { state: 'idle' });
      }
      const activeResult = this.cancelResultBySid.get(command.sid);
      if (activeResult !== undefined) {
        this.options.journal.markDone(msgId, activeResult);
        return activeResult;
      }
      return this.finish(msgId, this.failureEvent(msgId, command, new RunnerFailure('CANCELLED', 'Cancellation acknowledged.')));
    } catch (error) {
      return this.finish(msgId, this.failureEvent(msgId, command, new RunnerFailure('GIT_ERROR', errorMessage(error), undefined, { cause: error })));
    } finally {
      this.cancelResultBySid.delete(command.sid);
      const key = this.cancelWorkByMessage.get(msgId);
      if (key !== undefined && key !== null) this.cancelledWork.delete(key);
      this.cancelWorkByMessage.delete(msgId);
    }
  }

  private async executeTurnCommand(
    msgId: string,
    command: Exclude<Command, { type: 'session.open' | 'session.close' | 'task.cancel' }>,
    signal: AbortSignal,
    usage: UsageAccumulator,
  ): Promise<Event> {
    const session = this.requireSession(command.sid);
    const profile = this.sessionProfile(session);
    const expected = expectedProfile(command);
    if (profile !== expected) {
      throw new RunnerFailure('ADAPTER_ERROR', `Command ${command.type} requires a ${expected} session, but ${command.sid} is ${profile}.`);
    }
    await this.compactIfNeeded(session, profile, command, signal, usage);
    this.throwIfAborted(signal);

    switch (command.type) {
      case 'author.start':
        return this.authorStart(msgId, command, signal, usage);
      case 'author.revise':
        return this.authorRevise(msgId, command, signal, usage);
      case 'author.sync':
        return this.authorSync(msgId, command, signal, usage);
      case 'review.start':
        return this.reviewStart(msgId, command, signal, usage);
      case 'review.rereview':
        return this.reviewRereview(msgId, command, signal, usage);
      case 'directive.run':
        return this.directiveRun(msgId, command, signal, usage);
    }
  }

  private async authorStart(
    msgId: string,
    command: AuthorStartCommand,
    signal: AbortSignal,
    usage: UsageAccumulator,
  ): Promise<Event> {
    const config = this.worktreeConfig();
    const baseCommit = command.continueExisting
      ? await prepareAuthorExistingBranch(config, command.sid, command.branch)
      : await prepareAuthorNewBranch(config, command.sid, command.branch);
    await ensureCleanBeforeAuthorTurn(config, command.sid);
    await runSetupIfNeeded(this.worktree(command.sid), config.mainBranch);
    const output = await this.runAuthorTurns<AuthorStartOutput>(
      command.sid,
      command,
      authorStartPrompt(command, this.worktree(command.sid)),
      AuthorStartOutputSchema,
      {},
      signal,
      usage,
      command.taskId,
      1,
    );
    const details = await diffInfo(config, command.sid, baseCommit);
    const tests = await this.runProjectTests(command.sid, config.mainBranch);
    const headCommit = await this.headCommit(command.sid);
    return {
      type: 'author.submitted',
      inReplyTo: msgId,
      sid: command.sid,
      taskId: command.taskId,
      status: output.status,
      ...(output.status === 'blocked' ? { blockedReason: output.blockedReason } : {}),
      summary: output.summary,
      responses: [],
      headCommit,
      baseCommit,
      filesChanged: details.filesChanged,
      diffLines: details.diffLines,
      tests,
      usage: usage.value(this.sessionContext(command.sid)),
    };
  }

  private async authorRevise(
    msgId: string,
    command: AuthorReviseCommand,
    signal: AbortSignal,
    usage: UsageAccumulator,
  ): Promise<Event> {
    const config = this.worktreeConfig();
    await prepareAuthorExistingBranch(config, command.sid, command.branch);
    await ensureCleanBeforeAuthorTurn(config, command.sid);
    await runSetupIfNeeded(this.worktree(command.sid), config.mainBranch);
    const output = await this.runAuthorTurns<AuthorReviseOutput>(
      command.sid,
      command,
      authorRevisePrompt(command, this.worktree(command.sid)),
      AuthorReviseOutputSchema,
      { blockingIssueCodes: command.openIssues.map((issue) => issue.code) },
      signal,
      usage,
      command.taskId,
      command.round,
    );
    const baseCommit = await this.mergeBase(command.sid, command.branch);
    const details = await diffInfo(config, command.sid, baseCommit);
    const tests = await this.runProjectTests(command.sid, config.mainBranch);
    const headCommit = await this.headCommit(command.sid);
    return {
      type: 'author.submitted',
      inReplyTo: msgId,
      sid: command.sid,
      taskId: command.taskId,
      status: output.status,
      ...(output.status === 'blocked' ? { blockedReason: output.blockedReason } : {}),
      summary: output.summary,
      responses: 'responses' in output ? output.responses : [],
      headCommit,
      baseCommit,
      filesChanged: details.filesChanged,
      diffLines: details.diffLines,
      tests,
      usage: usage.value(this.sessionContext(command.sid)),
    };
  }

  private async authorSync(
    msgId: string,
    command: AuthorSyncCommand,
    signal: AbortSignal,
    usage: UsageAccumulator,
  ): Promise<Event> {
    const config = { ...this.worktreeConfig(), mainBranch: command.mainBranch };
    const sync = await syncWithMain(config, command.sid, command.branch);
    if (sync.hadConflicts) {
      const prompt = authorSyncPrompt(command, this.worktree(command.sid), sync.conflictedFiles);
      await this.runSyncTurns(
        command.sid,
        prompt,
        taskMarker({ id: command.taskId, title: `task ${command.taskId}` }),
        signal,
        usage,
      );
      const head = await finishSync(config, command.sid, command.branch, sync.conflictedFiles);
      this.options.enqueueEvent({ type: 'author.checkpoint', sid: command.sid, taskId: command.taskId, commit: head });
    } else {
      const pushed = await git(this.worktree(command.sid), ['push', 'origin', command.branch]);
      assertGitSuccess(pushed, `push synced author branch ${command.branch}`);
    }
    const tests = await this.runProjectTests(command.sid, command.mainBranch);
    const headCommit = await this.headCommit(command.sid);
    return {
      type: 'author.synced',
      inReplyTo: msgId,
      sid: command.sid,
      taskId: command.taskId,
      headCommit,
      hadConflicts: sync.hadConflicts,
      tests,
      usage: usage.value(this.sessionContext(command.sid)),
    };
  }

  private async reviewStart(
    msgId: string,
    command: ReviewStartCommand,
    signal: AbortSignal,
    usage: UsageAccumulator,
  ): Promise<Event> {
    await prepareReviewer(this.worktreeConfig(), command.sid, command.headCommit);
    try {
      const diff = await this.readReviewDiff(command.sid, command.baseCommit, command.headCommit, true);
      const prompt = reviewStartPrompt(command, this.worktree(command.sid), diff);
      const output = await this.runReviewTurns(
        command.sid,
        prompt,
        { priorIssueCodes: command.priorIssues.map((issue) => issue.code) },
        taskMarker(command.task),
        signal,
        usage,
      );
      return {
        type: 'review.completed',
        inReplyTo: msgId,
        sid: command.sid,
        taskId: command.taskId,
        conversationId: command.conversationId,
        reviewedCommit: command.headCommit,
        output,
        usage: usage.value(this.sessionContext(command.sid)),
      };
    } finally {
      await resetIfReviewerModified(this.worktreeConfig(), command.sid);
    }
  }

  private async reviewRereview(
    msgId: string,
    command: ReviewRereviewCommand,
    signal: AbortSignal,
    usage: UsageAccumulator,
  ): Promise<Event> {
    await prepareReviewer(this.worktreeConfig(), command.sid, command.headCommit);
    try {
      const diff = await this.readReviewDiff(command.sid, command.fromCommit, command.headCommit, false);
      const prompt = reviewRereviewPrompt(command, this.worktree(command.sid), diff);
      const output = await this.runReviewTurns(
        command.sid,
        prompt,
        { priorIssueCodes: command.openIssues.map((issue) => issue.code) },
        taskMarker(command.task),
        signal,
        usage,
      );
      return {
        type: 'review.completed',
        inReplyTo: msgId,
        sid: command.sid,
        taskId: command.taskId,
        conversationId: command.conversationId,
        reviewedCommit: command.headCommit,
        output,
        usage: usage.value(this.sessionContext(command.sid)),
      };
    } finally {
      await resetIfReviewerModified(this.worktreeConfig(), command.sid);
    }
  }

  private async directiveRun(
    msgId: string,
    command: DirectiveRunCommand,
    signal: AbortSignal,
    usage: UsageAccumulator,
  ): Promise<Event> {
    const session = this.requireSession(command.sid);
    const profile = this.sessionProfile(session);
    const prompt = directivePrompt(command, session.worktree);
    const output = await this.runParsedTurns<DirectiveOutput>(
      command.sid,
      profile,
      prompt,
      DirectiveOutputSchema,
      {},
      directiveMarker(command.directiveId),
      signal,
      usage,
    );
    return {
      type: 'directive.completed',
      inReplyTo: msgId,
      sid: command.sid,
      directiveId: command.directiveId,
      text: output.answer,
      usage: usage.value(this.sessionContext(command.sid)),
    };
  }

  private async runAuthorTurns<T extends AuthorStartOutput | AuthorReviseOutput>(
    sid: string,
    command: AuthorStartCommand | AuthorReviseCommand,
    initialPrompt: string,
    schema: ZodType<T>,
    parseOptions: { blockingIssueCodes?: readonly string[] },
    signal: AbortSignal,
    usage: UsageAccumulator,
    taskId: number,
    round: number,
  ): Promise<T> {
    let prompt = initialPrompt;
    for (let attempt = 0; attempt <= this.options.config.maxInvalidOutputRetries; attempt += 1) {
      this.throwIfAborted(signal);
      const turn = await this.runTurn(sid, prompt, signal, usage);
      await commitAndPushAfterAuthorTurn(this.worktreeConfig(), sid, command.branch, taskId, round + attempt);
      const head = await this.headCommit(sid);
      this.options.enqueueEvent({ type: 'author.checkpoint', sid, taskId, commit: head });
      const parsed = parseOutput(turn.text, schema, parseOptions);
      if (parsed.ok) return parsed.value as T;
      if (attempt >= this.options.config.maxInvalidOutputRetries) {
        throw new RunnerFailure('INVALID_OUTPUT', parsed.error);
      }
      prompt = markedRetry(taskMarker(command.task), parsed.retryPrompt);
    }
    throw new RunnerFailure('INVALID_OUTPUT', 'Invalid output retry limit reached.');
  }

  private async runSyncTurns(
    sid: string,
    initialPrompt: string,
    retryMarker: string,
    signal: AbortSignal,
    usage: UsageAccumulator,
  ): Promise<SyncOutput> {
    let prompt = initialPrompt;
    for (let attempt = 0; attempt <= this.options.config.maxInvalidOutputRetries; attempt += 1) {
      this.throwIfAborted(signal);
      const turn = await this.runTurn(sid, prompt, signal, usage);
      const parsed = parseOutput(turn.text, SyncOutputSchema);
      if (parsed.ok) return parsed.value;
      if (attempt >= this.options.config.maxInvalidOutputRetries) throw new RunnerFailure('INVALID_OUTPUT', parsed.error);
      prompt = markedRetry(retryMarker, parsed.retryPrompt);
    }
    throw new RunnerFailure('INVALID_OUTPUT', 'Invalid output retry limit reached.');
  }

  private async runReviewTurns(
    sid: string,
    initialPrompt: string,
    parseOptions: { priorIssueCodes: readonly string[] },
    retryMarker: string,
    signal: AbortSignal,
    usage: UsageAccumulator,
  ): Promise<ReviewOutput> {
    let prompt = initialPrompt;
    for (let attempt = 0; attempt <= this.options.config.maxInvalidOutputRetries; attempt += 1) {
      this.throwIfAborted(signal);
      const turn = await this.runTurn(sid, prompt, signal, usage);
      const parsed = parseOutput(turn.text, ReviewOutputSchema, parseOptions);
      if (parsed.ok) return parsed.value;
      if (attempt >= this.options.config.maxInvalidOutputRetries) throw new RunnerFailure('INVALID_OUTPUT', parsed.error);
      prompt = markedRetry(retryMarker, parsed.retryPrompt);
    }
    throw new RunnerFailure('INVALID_OUTPUT', 'Invalid output retry limit reached.');
  }

  private async runParsedTurns<T>(
    sid: string,
    profile: Profile,
    initialPrompt: string,
    schema: ZodType<T>,
    parseOptions: { priorIssueCodes?: readonly string[] },
    retryMarker: string,
    signal: AbortSignal,
    usage: UsageAccumulator,
    internalMarker?: string,
  ): Promise<T> {
    let prompt = initialPrompt;
    for (let attempt = 0; attempt <= this.options.config.maxInvalidOutputRetries; attempt += 1) {
      this.throwIfAborted(signal);
      const turn = await this.runTurn(sid, prompt, signal, usage, profile);
      const parsed = parseOutput(turn.text, schema, parseOptions);
      if (parsed.ok) return parsed.value as T;
      if (attempt >= this.options.config.maxInvalidOutputRetries) throw new RunnerFailure('INVALID_OUTPUT', parsed.error);
      prompt = markedRetry(retryMarker, parsed.retryPrompt, internalMarker);
    }
    throw new RunnerFailure('INVALID_OUTPUT', 'Invalid output retry limit reached.');
  }

  private async compactIfNeeded(
    session: JournalSession,
    profile: Profile,
    command: Exclude<Command, { type: 'session.open' | 'session.close' | 'task.cancel' }>,
    signal: AbortSignal,
    usage: UsageAccumulator,
  ): Promise<void> {
    const contextWindow = this.options.getContextWindow?.() ?? this.options.config.adapter.contextWindow;
    if (session.contextTokens <= this.options.config.contextPressurePct * contextWindow) return;
    this.throwIfAborted(signal);
    const identity = promptIdentity(command);
    const summarize = summarizePrompt({
      worktree: session.worktree,
      profile,
      ...(identity.task !== undefined ? { task: identity.task } : {}),
      ...(identity.directiveId !== undefined ? { directiveId: identity.directiveId } : {}),
    });
    const summary = await this.runParsedTurns<SummarizeOutput>(
      command.sid,
      profile,
      summarize,
      SummarizeOutputSchema,
      {},
      identity.task !== undefined
        ? taskMarker(identity.task)
        : identity.directiveId !== undefined ? directiveMarker(identity.directiveId) : 'QUORUM-SUMMARIZE',
      signal,
      usage,
      identity.task !== undefined || identity.directiveId !== undefined ? 'QUORUM-SUMMARIZE' : undefined,
    );
    const priorNativeId = this.requireSession(command.sid).nativeId;
    const created = await this.options.adapter.createSession({ cwd: session.worktree, profile });
    let seeded: TurnResult & { nativeId: string };
    try {
      seeded = await this.runTurn(
        command.sid,
        seedSessionPrompt({
          worktree: session.worktree,
          profile,
          ...(identity.task !== undefined ? { task: identity.task } : {}),
          ...(identity.directiveId !== undefined ? { directiveId: identity.directiveId } : {}),
          summary: summary.summary,
        }),
        signal,
        usage,
        profile,
        { nativeId: created.nativeId, persist: false },
      );
    } catch (error) {
      if (created.nativeId !== null) await this.options.adapter.closeSession(created.nativeId).catch(() => undefined);
      throw error;
    }
    this.options.journal.updateSession(command.sid, { nativeId: seeded.nativeId, contextTokens: seeded.contextTokens });
    if (priorNativeId !== null && priorNativeId !== seeded.nativeId) {
      await this.options.adapter.closeSession(priorNativeId).catch((error: unknown) => this.reportError(error));
    }
    this.options.enqueueEvent({
      type: 'session.compacted',
      sid: command.sid,
      contextTokensBefore: session.contextTokens,
      contextTokensAfter: seeded.contextTokens,
    });
  }

  private async runTurn(
    sid: string,
    prompt: string,
    signal: AbortSignal,
    usage: UsageAccumulator,
    profileOverride?: Profile,
    options: { nativeId?: string | null; persist?: boolean } = {},
  ): Promise<TurnResult & { nativeId: string }> {
    this.throwIfAborted(signal);
    const session = this.requireSession(sid);
    const profile = profileOverride ?? this.sessionProfile(session);
    const result = await this.options.adapter.runTurn({
      nativeId: options.nativeId === undefined ? session.nativeId : options.nativeId,
      cwd: session.worktree,
      profile,
      prompt,
      signal,
      timeoutMs: this.options.turnTimeoutSec() * 1000,
    });
    usage.add(result);
    if (options.persist !== false) {
      this.options.journal.updateSession(sid, {
        nativeId: result.nativeId,
        contextTokens: result.contextTokens,
      });
    }
    return result;
  }

  private async readReviewDiff(
    sid: string,
    fromCommit: string,
    toCommit: string,
    threeDot: boolean,
  ): Promise<ReviewDiff> {
    const cwd = this.worktree(sid);
    const range = `${fromCommit}${threeDot ? '...' : '..'}${toCommit}`;
    const [statResult, filesResult, statsResult] = await Promise.all([
      git(cwd, ['diff', '--stat', range]),
      git(cwd, ['diff', '--name-only', '-z', range]),
      git(cwd, ['diff', '--numstat', '-z', range]),
    ]);
    assertGitSuccess(statResult, 'read review diff stat');
    assertGitSuccess(filesResult, 'list review diff files');
    assertGitSuccess(statsResult, 'calculate review diff size');
    const diffLines = countNumstatLines(statsResult.stdout);
    let diff = '';
    if (diffLines <= this.options.config.maxDiffLinesInPrompt) {
      const result = await git(cwd, ['diff', range]);
      assertGitSuccess(result, 'read review diff');
      diff = result.stdout;
    }
    return {
      diff,
      stat: statResult.stdout,
      diffLines,
      fileCount: filesResult.stdout.split('\0').filter(Boolean).length,
      maxDiffLinesInPrompt: this.options.config.maxDiffLinesInPrompt,
    };
  }

  private async runProjectTests(sid: string, mainBranch: string): Promise<TestResult> {
    const worktree = this.worktree(sid);
    try {
      await runSetupIfNeeded(worktree, mainBranch);
    } catch (error) {
      return failedTest(errorMessage(error));
    }
    try {
      return await runTests(worktree, mainBranch);
    } catch (error) {
      return failedTest(errorMessage(error));
    }
  }

  private async mergeBase(sid: string, branch: string): Promise<string> {
    const result = await git(this.worktree(sid), ['merge-base', 'HEAD', `origin/${this.options.mainBranch()}`]);
    assertGitSuccess(result, `find base commit for ${branch}`);
    return result.stdout.trim();
  }

  private async headCommit(sid: string): Promise<string> {
    const result = await git(this.worktree(sid), ['rev-parse', 'HEAD']);
    assertGitSuccess(result, 'read current commit');
    return result.stdout.trim();
  }

  private async tryRemoveWorktree(sid: string): Promise<void> {
    try {
      await removeWorktree(this.worktreeConfig(), sid);
    } catch (error) {
      this.reportError(error);
    }
  }

  private finish(msgId: string, event: Event): string {
    const eventMsgId = this.options.enqueueEvent(event);
    this.options.journal.markDone(msgId, eventMsgId);
    return eventMsgId;
  }

  private failureEvent(msgId: string, command: Command, error: unknown, usage?: Usage): Event {
    const mapped = mapFailure(error);
    const ids = 'taskId' in command && command.taskId !== undefined
      ? { taskId: command.taskId }
      : 'directiveId' in command && command.directiveId !== undefined ? { directiveId: command.directiveId } : {};
    return {
      type: 'turn.failed',
      inReplyTo: msgId,
      sid: command.sid,
      ...ids,
      code: mapped.code,
      message: mapped.message,
      ...(mapped.resetAt === undefined ? {} : { resetAt: mapped.resetAt }),
      ...(usage === undefined ? {} : { usage }),
    };
  }

  private requireSession(sid: string): JournalSession {
    const session = this.options.journal.getSession(sid);
    if (session === null) throw new RunnerFailure('ADAPTER_ERROR', `Unknown session: ${sid}`);
    return session;
  }

  private sessionProfile(session: JournalSession): Profile {
    if (session.profile !== 'author' && session.profile !== 'reviewer' && session.profile !== 'directive') {
      throw new RunnerFailure('ADAPTER_ERROR', `Session ${session.sid} has no valid profile.`);
    }
    return session.profile;
  }

  private sessionContext(sid: string): number {
    return this.options.journal.getSession(sid)?.contextTokens ?? 0;
  }

  private worktree(sid: string): string {
    return this.options.journal.getSession(sid)?.worktree ?? join(this.options.config.workspaceDir, 'worktrees', sid);
  }

  private worktreeConfig(): WorktreeConfig {
    return {
      workspaceDir: this.options.config.workspaceDir,
      repoRemoteUrl: this.options.config.repoRemoteUrl,
      mainBranch: this.options.mainBranch(),
      gitIdentity: this.options.config.gitIdentity,
    };
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new AdapterError('CANCELLED', 'Command cancelled.');
  }

  private reportError(error: unknown): void {
    this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}

function commandWorkKey(command: Command): string | null {
  if ('taskId' in command) return `${command.sid}\0task:${command.taskId}`;
  if ('directiveId' in command) return `${command.sid}\0directive:${command.directiveId}`;
  return null;
}

function expectedProfile(command: Exclude<Command, { type: 'session.open' | 'session.close' | 'task.cancel' }>): Profile {
  switch (command.type) {
    case 'author.start':
    case 'author.revise':
    case 'author.sync':
      return 'author';
    case 'review.start':
    case 'review.rereview':
      return 'reviewer';
    case 'directive.run':
      return 'directive';
  }
}

function promptIdentity(command: Exclude<Command, { type: 'session.open' | 'session.close' | 'task.cancel' }>): {
  task?: { id: number; title: string };
  directiveId?: string;
} {
  if ('task' in command) return { task: { id: command.task.id, title: command.task.title } };
  if ('taskId' in command) return { task: { id: command.taskId, title: `task ${command.taskId}` } };
  return { directiveId: command.directiveId };
}

function countNumstatLines(value: string): number {
  let lines = 0;
  for (const record of value.split('\0')) {
    if (record.length === 0) continue;
    const firstTab = record.indexOf('\t');
    const secondTab = record.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const added = Number(record.slice(0, firstTab));
    const deleted = Number(record.slice(firstTab + 1, secondTab));
    if (Number.isFinite(added)) lines += added;
    if (Number.isFinite(deleted)) lines += deleted;
  }
  return lines;
}

function failedTest(outputTail: string): TestResult {
  return { passed: false, exitCode: 1, outputTail, durationMs: 0, timedOut: false };
}

function markedRetry(marker: string, retryPrompt: string, internalMarker?: string): string {
  return internalMarker === undefined
    ? `${marker}\n\n${retryPrompt}`
    : `${marker}\n\n${internalMarker}\n\n${retryPrompt}`;
}

function mapFailure(error: unknown): { code: 'RATE_LIMITED' | 'ADAPTER_ERROR' | 'INVALID_OUTPUT' | 'CANCELLED' | 'TIMEOUT' | 'GIT_ERROR'; message: string; resetAt?: number } {
  if (error instanceof AdapterError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.resetAt === undefined ? {} : { resetAt: error.resetAt }),
    };
  }
  if (error instanceof RunnerFailure) {
    return { code: error.code, message: error.message, ...(error.resetAt === undefined ? {} : { resetAt: error.resetAt }) };
  }
  if (error instanceof GitExecutionError || error instanceof GitTimeoutError || error instanceof ConflictResolutionError) {
    return { code: 'GIT_ERROR', message: error.message };
  }
  return { code: 'ADAPTER_ERROR', message: errorMessage(error) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
