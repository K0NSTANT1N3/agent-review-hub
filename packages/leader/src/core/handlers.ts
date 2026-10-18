import {
  CommandSchema, type CmdFrame, type Event, type LeaderConfig, type SessionOpenedEvent,
} from '@quorum/protocol';
import type { ConversationRow, LeaderDb, MessageRow, SessionRow, TaskRow } from '../db/repo.js';
import { LockManager } from './locks.js';
import { isTerminal, transition, transitionToAuthorState } from './state-machine.js';
import { applyReview, nextIssueCode } from './review.js';
import * as commands from './commands.js';
import { recordTurnUsage } from './usage.js';

export interface HandlerOptions {
  now?: () => number;
  estimate?: (task: TaskRow, agentId: string, role: 'author' | 'reviewer') => number;
  onSessionOpened?: (session: SessionRow, event: SessionOpenedEvent, request: MessageRow) => void;
  onSessionLost?: (session: SessionRow, reason: string) => void;
  onRateLimited?: (agentId: string, until: number) => void;
  onChange?: () => void;
  onAttention?: (taskId: number, reason: 'no_reviewer' | 'author_unavailable' | 'escalated', message: string) => void;
  onFinished?: (task: TaskRow) => void;
}

export class EventHandlers {
  private readonly now: () => number;
  constructor(private readonly db: LeaderDb, readonly config: LeaderConfig, readonly locks: LockManager, private readonly options: HandlerOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  handle(agentId: string, event: Event): void {
    this.db.withTx(() => {
      const session = this.db.sessions.get(event.sid);
      if (session?.agent_id !== agentId) return;
      // Usage remains chargeable even when a delayed result is no longer actionable.
      recordTurnUsage(this.db, agentId, event, this.now(), this.config.costEstimate.emaAlpha);
      this.changed();
      if (event.type === 'session.opened') {
        const request = this.db.messages.get(event.inReplyTo);
        if (session.state !== 'opening' || request?.agent_id !== agentId || request.session_id !== event.sid || request.type !== 'session.open' || request.direction !== 'to_node') return;
        this.db.sessions.update(session.id, { state: event.ok ? 'idle' : 'lost', last_used_at: this.now() });
        this.options.onSessionOpened?.(session, event, request);
      } else if (event.type === 'session.closed') {
        const request = this.db.messages.get(event.inReplyTo);
        if (session.state !== 'closing' || request?.agent_id !== agentId || request.session_id !== session.id || request.type !== 'session.close') return;
        this.db.sessions.update(session.id, { state: 'closed', closed_at: this.now() });
      } else if (event.type === 'session.compacted') {
        this.db.sessions.update(session.id, { context_tokens: event.contextTokensAfter });
      } else if (event.type === 'session.lost') {
        if (this.options.onSessionLost !== undefined) this.options.onSessionLost(session, event.reason);
        else this.sessionLost(session, event.reason);
      } else if (event.type === 'author.checkpoint') {
        const task = this.db.tasks.get(event.taskId);
        if (!this.matches(task, session, 'author', ['AUTHORING', 'SYNCING'])) return;
        this.db.tasks.update(event.taskId, { head_commit: event.commit });
      } else if (event.type === 'directive.completed') {
        const directive = this.db.directives.get(event.directiveId);
        if (directive?.state !== 'running' || directive.agent_id !== agentId || directive.session_id !== session.id
          || session.lock_kind !== 'directive' || session.lock_ref !== directive.id || !this.validReply(session, event.inReplyTo, ['directive.run'])) return;
        this.db.directives.update(directive.id, { state: 'done', result_text: event.text, finished_at: this.now() });
        this.locks.releaseSession(session.id, 'idle');
      } else if (event.type === 'turn.failed') {
        this.turnFailed(session, event);
      } else {
        const task = this.db.tasks.get(event.taskId);
        if (event.type === 'author.submitted') {
          if (!this.matches(task, session, 'author', ['AUTHORING']) || !this.validReply(session, event.inReplyTo, ['author.start', 'author.revise'])) return;
          this.authorSubmitted(this.db.tasks.require(event.taskId), event);
        } else if (event.type === 'author.synced') {
          if (!this.matches(task, session, 'author', ['SYNCING']) || !this.validReply(session, event.inReplyTo, ['author.sync'])) return;
          this.authorSynced(this.db.tasks.require(event.taskId), event);
        } else if (event.type === 'review.completed') {
          if (!this.matches(task, session, 'reviewer', ['IN_REVIEW']) || !this.validReply(session, event.inReplyTo, ['review.start', 'review.rereview'])) return;
          const conversation = this.activeConversation(event.taskId);
          if (conversation?.id !== event.conversationId || conversation.reviewer_session_id !== session.id || task?.head_commit !== event.reviewedCommit) return;
          this.reviewCompleted(this.db.tasks.require(event.taskId), event);
        }
      }
    });
  }

  sendAuthor(taskId: number, kind: 'start' | 'revise' | 'sync', continueExisting = false): CmdFrame {
    return this.db.withTx(() => {
      const task = this.db.tasks.require(taskId);
      if (task.state !== (kind === 'sync' ? 'SYNCING' : 'AUTHORING')) throw new Error('Task state does not allow this author command');
      if (task.author_session_id === null || task.author_agent_id === null) throw new Error('Author assignment required');
      const estimated = this.estimate(task, task.author_agent_id, 'author');
      const command = kind === 'start' ? commands.authorStart(this.db, task, task.author_session_id, estimated, continueExisting)
        : kind === 'sync' ? commands.authorSync(this.db, task, this.config.repo.mainBranch, estimated)
          : commands.authorRevise(this.db, task, estimated);
      return this.locks.sendToSession(task.author_session_id, command);
    });
  }

  sendReview(taskId: number, conversationId: string, kind: 'start' | 'rereview', summary = '', reason: 'revision' | 'sync_conflicts' = 'revision'): CmdFrame {
    return this.db.withTx(() => {
      const before = this.db.tasks.require(taskId);
      const conversation = this.db.conversations.require(conversationId);
      if (before.state !== 'IN_REVIEW' || conversation.state !== 'active' || conversation.task_id !== taskId) throw new Error('Task is not ready for this review');
      const task = this.db.tasks.update(taskId, { review_round: before.review_round + 1 });
      const estimated = this.estimate(task, conversation.reviewer_agent_id, 'reviewer');
      // A human can send back or approve before the first review completes; then there is no reviewed commit yet.
      const start = kind === 'start' || task.last_reviewed_commit === null;
      const command = start ? commands.reviewStart(this.db, task, conversation, estimated)
        : commands.reviewRereview(this.db, task, conversation, estimated, summary, reason);
      return this.locks.sendToSession(conversation.reviewer_session_id, command);
    });
  }

  sessionLost(session: SessionRow, reason: string): void {
    this.db.withTx(() => {
      const current = this.db.sessions.require(session.id);
      if (!['closed', 'closing', 'lost'].includes(current.state)) this.locks.releaseSession(session.id, 'lost');
      if (session.lock_kind === 'directive' && session.lock_ref !== null) {
        const directive = this.db.directives.get(session.lock_ref);
        if (directive?.state === 'running') this.db.directives.update(directive.id, { state: 'failed', error: 'session_lost', finished_at: this.now() });
      } else if (session.lock_kind === 'task' && session.lock_ref !== null) {
        const task = this.db.tasks.get(Number(session.lock_ref));
        if (task !== undefined && !isTerminal(task.state)) {
          if (session.lock_role === 'author' && task.author_session_id === session.id && ['AUTHORING', 'SYNCING'].includes(task.state)) {
            transition(this.db, task.id, 'PAUSED', { reason: 'author_unavailable', actor: 'leader', data: { reason }, at: this.now() });
            this.attention(task.id, 'author_unavailable', reason);
          } else if (session.lock_role === 'reviewer') {
            this.abandonReviewer(task, session.id, reason);
          }
        }
      }
      this.changed();
    });
  }

  finishTask(taskId: number, state: 'CANCELLED' | 'FAILED' | 'MERGED', reason: string, actor = 'leader'): void {
    this.db.withTx(() => {
      const task = this.db.tasks.require(taskId);
      if (isTerminal(task.state)) return;
      transition(this.db, taskId, state, { reason, actor, at: this.now() });
      for (const session of this.db.sessions.find({ lock_kind: 'task', lock_ref: String(taskId), state: 'locked' })) {
        if (state !== 'MERGED') this.locks.sendToSession(session.id, { type: 'task.cancel', sid: session.id, taskId });
        this.locks.releaseSession(session.id, 'idle');
      }
      for (const conversation of this.db.conversations.find({ task_id: taskId, state: 'active' })) this.db.conversations.update(conversation.id, { state: 'closed', ended_at: this.now() });
      this.db.mergeQueue.delete(taskId);
      this.db.afterCommit(() => this.options.onFinished?.(this.db.tasks.require(taskId)));
      this.changed();
    });
  }

  mergeTestsFailed(taskId: number, output: string): void {
    this.db.withTx(() => {
      this.db.tasks.update(taskId, { last_test_output: output });
      this.testFailure(taskId, output, 'tests_failing_after_merge');
      this.changed();
    });
  }

  testsPassed(taskId: number): void {
    this.db.withTx(() => {
      for (const issue of this.db.issues.find({ task_id: taskId, source: 'system', status: 'open' })) this.db.issues.update(issue.id, { status: 'resolved' });
      this.db.tasks.update(taskId, { test_fix_attempts: 0 });
    });
  }

  private authorSubmitted(task: TaskRow, event: Extract<Event, { type: 'author.submitted' }>): void {
    this.db.tasks.update(task.id, {
      head_commit: event.headCommit, base_commit: event.baseCommit, files: JSON.stringify(event.filesChanged), diff_lines: event.diffLines,
      last_test_output: event.tests.outputTail, turn_retries: 0,
    });
    const session = this.db.sessions.require(event.sid);
    this.db.sessions.update(event.sid, {
      files: JSON.stringify([...new Set([...(JSON.parse(session.files) as string[]), ...event.filesChanged])]),
      task_history: JSON.stringify([...new Set([...(JSON.parse(session.task_history) as number[]), task.id])]), last_used_at: this.now(),
    });
    for (const response of event.responses) {
      const issue = this.db.issues.find({ task_id: task.id, code: response.issue })[0];
      if (issue !== undefined) this.db.issues.update(issue.id, { author_response: response.action, author_note: response.note });
    }
    this.overlapWarning(task.id, event.filesChanged);
    if (event.tests.passed) this.testsPassed(task.id);
    if (event.status === 'blocked') { this.escalate(task.id, `author_blocked: ${event.blockedReason ?? event.summary}`); return; }
    if (!event.tests.passed) { this.testFailure(task.id, event.tests.outputTail); return; }
    const conversation = this.activeConversation(task.id);
    transition(this.db, task.id, conversation === undefined ? 'AWAITING_REVIEWER' : 'IN_REVIEW', { reason: 'author_submitted', actor: `agent:${session.agent_id}`, at: this.now() });
    if (conversation !== undefined) this.sendReview(task.id, conversation.id, 'rereview', event.summary);
  }

  private authorSynced(task: TaskRow, event: Extract<Event, { type: 'author.synced' }>): void {
    this.db.tasks.update(task.id, { head_commit: event.headCommit, sync_had_conflicts: event.hadConflicts ? 1 : 0, last_test_output: event.tests.outputTail, turn_retries: 0 });
    if (!event.tests.passed) { this.testFailure(task.id, event.tests.outputTail); return; }
    this.testsPassed(task.id);
    if (!event.hadConflicts) { this.queueMerge(task.id, 'sync_clean'); return; }
    const conversation = this.activeConversation(task.id);
    transition(this.db, task.id, conversation === undefined ? 'AWAITING_REVIEWER' : 'IN_REVIEW', { reason: 'sync_conflicts_resolved', actor: 'leader', at: this.now() });
    if (conversation !== undefined) this.sendReview(task.id, conversation.id, 'rereview', 'Main-branch conflicts resolved', 'sync_conflicts');
  }

  private reviewCompleted(task: TaskRow, event: Extract<Event, { type: 'review.completed' }>): void {
    this.db.tasks.update(task.id, { last_reviewed_commit: event.reviewedCommit, turn_retries: 0 });
    const result = applyReview(this.db, task, event.conversationId, event.output, this.now());
    if (result.verdict === 'approve') { this.queueMerge(task.id, 'review_approved'); return; }
    if (result.openBlocking.some((issue) => issue.dispute_count >= this.config.limits.maxDisputesPerIssue)) { this.escalate(task.id, 'dispute_limit'); return; }
    if (task.review_round >= this.config.limits.maxReviewRounds) { this.escalate(task.id, 'review_round_limit'); return; }
    const updated = transitionToAuthorState(this.db, task.id, 'AUTHORING', { reason: 'review_changes', actor: 'leader', at: this.now() });
    if (updated.state === 'AUTHORING') this.sendAuthor(task.id, 'revise');
  }

  private testFailure(taskId: number, output: string, exhaustedReason = 'tests_failing'): void {
    const task = this.db.tasks.require(taskId);
    if (task.test_fix_attempts >= this.config.limits.maxTestFixAttempts) { this.escalate(taskId, exhaustedReason); return; }
    this.db.tasks.update(taskId, { test_fix_attempts: task.test_fix_attempts + 1 });
    this.db.issues.insert({ task_id: taskId, code: nextIssueCode(this.db, taskId), source: 'system', severity: 'blocking', comment: output || 'Project tests failed', status: 'open', raised_round: task.review_round, created_at: this.now() });
    const updated = transitionToAuthorState(this.db, taskId, 'AUTHORING', { reason: 'tests_failed', actor: 'leader', at: this.now() });
    if (updated.state === 'AUTHORING') this.sendAuthor(taskId, 'revise');
  }

  private turnFailed(session: SessionRow, event: Extract<Event, { type: 'turn.failed' }>): void {
    if (event.code === 'CANCELLED') {
      // The Node confirms a cancel only after its turn stopped, i.e. after any push of the task branch. Run the
      // finished-task cleanup (branch deletion) again so a push racing the first deletion can't leave a stale branch.
      const task = event.taskId === undefined ? undefined : this.db.tasks.get(event.taskId);
      if (task !== undefined && (task.state === 'CANCELLED' || task.state === 'FAILED')) {
        this.db.afterCommit(() => this.options.onFinished?.(task));
      }
      return;
    }
    const request = this.validReply(session, event.inReplyTo, ['author.start', 'author.revise', 'author.sync', 'review.start', 'review.rereview', 'directive.run']);
    if (request === undefined || session.state !== 'locked') return;
    const original = (JSON.parse(request.payload) as CmdFrame).cmd;
    if (('taskId' in original ? original.taskId : undefined) !== event.taskId
      || ('directiveId' in original ? original.directiveId : undefined) !== event.directiveId) return;
    const task = event.taskId === undefined ? undefined : this.db.tasks.get(event.taskId);
    if (event.taskId !== undefined && !this.matches(task, session, session.lock_role ?? '', session.lock_role === 'author' ? ['AUTHORING', 'SYNCING'] : ['IN_REVIEW'])) return;
    if (event.directiveId !== undefined && (session.lock_kind !== 'directive' || session.lock_ref !== event.directiveId || this.db.directives.get(event.directiveId)?.state !== 'running')) return;
    if (event.code === 'RATE_LIMITED') {
      const until = event.resetAt ?? this.now() + 900_000;
      this.db.agents.update(session.agent_id, { rate_limited_until: until });
      if (this.options.onRateLimited !== undefined) this.options.onRateLimited(session.agent_id, until);
      else if (task !== undefined && session.lock_role === 'author') transition(this.db, task.id, 'PAUSED', { reason: 'rate_limited', actor: 'leader', at: this.now() });
      else if (task !== undefined) { this.locks.releaseSession(session.id, 'idle'); this.abandonReviewer(task, session.id, 'rate_limited'); }
      else if (event.directiveId !== undefined) { this.db.directives.update(event.directiveId, { state: 'queued', session_id: null }); this.locks.releaseSession(session.id, 'idle'); }
      return;
    }
    if (event.code === 'GIT_ERROR' && task !== undefined) { this.finishTask(task.id, 'FAILED', 'git_error'); return; }
    const retries = task === undefined
      ? this.db.messages.find({ direction: 'to_node', directive_id: event.directiveId ?? null, type: 'directive.run' }).length
      : task.turn_retries + 1;
    if (task !== undefined) this.db.tasks.update(task.id, { turn_retries: retries });
    if (retries <= this.config.limits.maxTurnRetries) {
      this.locks.sendToSession(session.id, CommandSchema.parse((JSON.parse(request.payload) as CmdFrame).cmd));
    } else if (task !== undefined && session.lock_role === 'author') this.escalate(task.id, `author_turn_failed:${event.code}`);
    else if (task !== undefined) this.sessionLost(session, `reviewer_turn_failed:${event.code}`);
    else if (event.directiveId !== undefined) {
      this.db.directives.update(event.directiveId, { state: 'failed', error: event.message, finished_at: this.now() });
      this.locks.releaseSession(session.id, 'idle');
    }
  }

  private validReply(session: SessionRow, inReplyTo: string, types: string[]): MessageRow | undefined {
    const request = this.db.latestTurnCommand(session.id);
    return request?.id === inReplyTo && request.agent_id === session.agent_id && types.includes(request.type) ? request : undefined;
  }

  private matches(task: TaskRow | undefined, session: SessionRow, role: string, states: string[]): boolean {
    if (task === undefined || !states.includes(task.state) || session.state !== 'locked' || session.lock_kind !== 'task' || session.lock_ref !== String(task.id) || session.lock_role !== role) return false;
    if (role === 'author') return task.author_session_id === session.id && task.author_agent_id === session.agent_id;
    const conversation = this.activeConversation(task.id);
    return role === 'reviewer' && conversation?.reviewer_session_id === session.id && conversation.reviewer_agent_id === session.agent_id;
  }

  private activeConversation(taskId: number): ConversationRow | undefined { return this.db.conversations.find({ task_id: taskId, state: 'active' })[0]; }

  private queueMerge(taskId: number, reason: string): void {
    transition(this.db, taskId, 'MERGE_QUEUED', { reason, actor: 'leader', at: this.now() });
    const task = this.db.tasks.require(taskId);
    this.db.tasks.update(taskId, { approved_at: task.approved_at ?? this.now() });
    if (this.db.mergeQueue.get(taskId) === undefined) this.db.mergeQueue.insert({ task_id: taskId, enqueued_at: this.now() });
  }

  escalate(taskId: number, reason: string): void {
    this.db.tasks.update(taskId, { escalation_reason: reason });
    transition(this.db, taskId, 'ESCALATED', { reason, actor: 'leader', at: this.now() });
    this.attention(taskId, 'escalated', reason);
  }

  private abandonReviewer(task: TaskRow, sid: string, reason: string): void {
    for (const conversation of this.db.conversations.find({ task_id: task.id, state: 'active' })) {
      if (conversation.reviewer_session_id === sid) this.db.conversations.update(conversation.id, { state: 'abandoned', ended_at: this.now() });
    }
    if (task.state === 'IN_REVIEW' || task.state === 'AUTHORING') transition(this.db, task.id, task.state === 'IN_REVIEW' ? 'AWAITING_REVIEWER' : 'AUTHORING', { reason, actor: 'leader', at: this.now() });
    if (task.state === 'PAUSED' && task.paused_from_state === 'IN_REVIEW') this.db.tasks.update(task.id, { paused_from_state: 'AWAITING_REVIEWER' });
  }

  private overlapWarning(taskId: number, files: string[]): void {
    const task = this.db.tasks.require(taskId);
    const wanted = new Set(files);
    for (const other of this.db.tasks.all()) {
      if (other.id === taskId || isTerminal(other.state)) continue;
      const overlap = (JSON.parse(other.files) as string[]).filter((file) => wanted.has(file));
      if (overlap.length !== 0) this.db.taskEvents.insert({ task_id: taskId, from_state: task.state, to_state: task.state, reason: 'overlap_warning', actor: 'leader', data: JSON.stringify({ otherTaskId: other.id, files: overlap }), at: this.now() });
    }
  }

  private estimate(task: TaskRow, agentId: string, role: 'author' | 'reviewer'): number {
    if (this.options.estimate !== undefined) return this.options.estimate(task, agentId, role);
    const agent = this.db.agents.require(agentId);
    const c = this.config.costEstimate;
    return Math.round(agent.cost_ratio_ema * (role === 'author' ? c.authorTaskTokens : c.baseTokens + c.perDiffLine * task.diff_lines + c.perChangedFile * (JSON.parse(task.files) as string[]).length));
  }

  private changed(): void { this.db.afterCommit(() => this.options.onChange?.()); }
  private attention(taskId: number, reason: 'no_reviewer' | 'author_unavailable' | 'escalated', message: string): void {
    this.db.afterCommit(() => this.options.onAttention?.(taskId, reason, message));
  }
}
