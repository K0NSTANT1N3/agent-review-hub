import { randomUUID } from 'node:crypto';
import type { CmdFrame, LeaderConfig, SessionOpenedEvent, SessionProfile, TaskState } from '@quorum/protocol';
import type { AgentRow, LeaderDb, MessageRow, SessionRow, TaskRow } from '../db/repo.js';
import { silentLogger, type Logger } from '../logging.js';
import { budgetRemaining, dayStart, estimateAuthor, estimateReview, overlap, taskFiles } from './budget.js';
import type { EventHandlers } from './handlers.js';
import type { LockManager } from './locks.js';
import { isTerminal, transition } from './state-machine.js';

// Spec §9 (assignment) and §10.3–§10.5 (liveness). Everything runs synchronously inside DB transactions.

export const SESSION_OPEN_TIMEOUT_MS = 60_000;
export const OPEN_FAILURE_BACKOFF_MS = 5 * 60_000;
/** Leader-side backstop on top of the Node's own turn timeout. */
export const TURN_TIMEOUT_GRACE_MS = 60_000;

export interface SchedulerOptions {
  db: LeaderDb;
  config: LeaderConfig;
  locks: LockManager;
  handlers: EventHandlers;
  now?: () => number;
  logger?: Logger;
  /** Owner idle threshold reported in hello/heartbeat (not stored in the DB). */
  idleThresholdSec?: (agentId: string) => number | undefined;
  onAttention?: (taskId: number, reason: 'no_reviewer' | 'author_unavailable' | 'escalated', message: string) => void;
}

type Role = 'author' | 'reviewer';

interface Candidate {
  agent: AgentRow;
  score: number;
}

export class Scheduler {
  private readonly db: LeaderDb;
  private readonly config: LeaderConfig;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly openBackoff = new Map<string, number>();
  private readonly notified = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private triggered = false;
  private stopped = false;

  constructor(private readonly options: SchedulerOptions) {
    this.db = options.db;
    this.config = options.config;
    this.now = options.now ?? Date.now;
    this.log = options.logger ?? silentLogger;
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), this.config.scheduler.tickMs);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Debounced: at most one extra pass per event-loop turn. */
  trigger(): void {
    if (this.triggered || this.stopped) return;
    this.triggered = true;
    setImmediate(() => {
      this.triggered = false;
      this.tick();
    });
  }

  tick(): void {
    if (this.stopped) return;
    try {
      this.schedule();
    } catch (error) {
      this.log.error({ err: error }, 'scheduler pass failed');
    }
  }

  /** One full pass — spec §9 steps 1–5. Each item runs in its own savepoint so one failure doesn't block the rest. */
  schedule(): void {
    this.expire();
    for (const task of this.byPriority(['AWAITING_REVIEWER'])) this.guard(`assign reviewer ${task.id}`, () => this.assignReviewer(task.id));
    for (const task of this.byPriority(['QUEUED'])) this.guard(`assign author ${task.id}`, () => this.assignAuthor(task.id));
    for (const d of this.db.directives.find({ state: 'queued' }).sort((a, b) => a.created_at - b.created_at)) {
      this.guard(`directive ${d.id}`, () => this.runDirective(d.id));
    }
    this.closeIdleSessions();
  }

  /** Wired to EventHandlers.onSessionOpened: finish the assignment the open was requested for. */
  sessionOpened(session: SessionRow, event: SessionOpenedEvent, request: MessageRow): void {
    if (!event.ok) {
      this.openBackoff.set(session.agent_id, this.now() + OPEN_FAILURE_BACKOFF_MS);
      return;
    }
    const profile = (JSON.parse(request.payload) as CmdFrame).cmd as { profile?: SessionProfile };
    if (request.task_id !== null) {
      const task = this.db.tasks.get(request.task_id);
      if (task === undefined) return;
      if (profile.profile === 'author' && task.state === 'QUEUED') this.bindAuthor(task, session.id);
      else if (profile.profile === 'author' && this.awaitsAuthorSession(task, session.agent_id)) this.replaceAuthorSession(task, session.id);
      else if (profile.profile === 'reviewer' && task.state === 'AWAITING_REVIEWER') this.bindReviewer(task, session.id);
      // Otherwise the task moved on (e.g. a human paused it) while the session opened: it stays idle for reuse.
    } else if (request.directive_id !== null) {
      const directive = this.db.directives.get(request.directive_id);
      if (directive?.state === 'queued') this.bindDirective(directive.id, session.id);
    }
  }

  // ---------------------------------------------------------------------------
  // Eligibility helpers — spec §9.1
  // ---------------------------------------------------------------------------

  isOnline(a: AgentRow): boolean {
    return (
      a.status === 'online' &&
      a.revoked === 0 &&
      a.last_heartbeat_at !== null &&
      this.now() - a.last_heartbeat_at <= this.config.timeouts.agentOfflineAfterSec * 1000
    );
  }

  isRateLimited(a: AgentRow): boolean {
    return a.rate_limited_until !== null && a.rate_limited_until > this.now();
  }

  /** Locked plus opening sessions count against capacity (issue #9). */
  usedSlots(agentId: string): number {
    return this.db.sessions.find({ agent_id: agentId, state: 'locked' }).length + this.db.sessions.find({ agent_id: agentId, state: 'opening' }).length;
  }

  hasSlot(a: AgentRow): boolean {
    return this.usedSlots(a.id) < a.max_sessions;
  }

  mayLend(a: AgentRow): boolean {
    if (a.paused !== 0) return false;
    if (a.lend_mode === 'always') return true;
    if (a.lend_mode !== 'when_idle' || a.human_idle_sec === null) return false;
    const threshold = this.options.idleThresholdSec?.(a.id) ?? 300;
    return a.human_idle_sec >= threshold;
  }

  private backedOff(agentId: string): boolean {
    return (this.openBackoff.get(agentId) ?? 0) > this.now();
  }

  private ownerOf(agentId: string): string {
    return this.db.agents.require(agentId).owner_name;
  }

  private agentAffinity(agentId: string, files: string[]): number {
    const since = this.now() - this.config.scheduler.affinityLookbackHours * 3_600_000;
    let best = 0;
    for (const s of this.db.sessions.find({ agent_id: agentId })) {
      if (s.state === 'lost' || s.last_used_at < since) continue;
      best = Math.max(best, overlap(files, JSON.parse(s.files) as string[]));
    }
    return best;
  }

  private score(agent: AgentRow, task: TaskRow, role: Role, ownAgent: boolean, estimate: number): number {
    const w = this.config.scheduler.weights;
    const files = taskFiles(task);
    const affinity = this.agentAffinity(agent.id, files);
    const headroom = ownAgent
      ? 1
      : Math.min(1, Math.max(0, (budgetRemaining(this.db, agent, this.now(), this.config.dayBoundaryTz) - estimate) / Math.max(1, agent.lend_tokens_per_day)));
    const idleness = 1 - this.usedSlots(agent.id) / Math.max(1, agent.max_sessions);
    const taskTags = JSON.parse(task.tags) as string[];
    const agentTags = new Set(JSON.parse(agent.tags) as string[]);
    const expertise = taskTags.filter((t) => agentTags.has(t)).length / Math.max(1, taskTags.length);
    let pairPenalty = 0;
    let fairness = 0;
    if (role === 'reviewer' && task.author_agent_id !== null) {
      const recent = this.db.conversationsSince(this.now() - this.config.scheduler.pairPenaltyLookbackDays * 86_400_000);
      const ofAuthor = recent.filter((c) => c.author_agent_id === task.author_agent_id);
      pairPenalty = ofAuthor.filter((c) => c.reviewer_agent_id === agent.id).length / Math.max(1, ofAuthor.length);
      const today = this.db.conversationsSince(dayStart(this.now(), this.config.dayBoundaryTz));
      const counts = new Map<string, number>();
      for (const c of today) counts.set(c.reviewer_agent_id, (counts.get(c.reviewer_agent_id) ?? 0) + 1);
      fairness = (counts.get(agent.id) ?? 0) / Math.max(1, ...counts.values());
    }
    const requesterBonus = role === 'author' && ownAgent ? w.requesterBonus : 0;
    return (
      w.affinity * affinity +
      w.headroom * headroom +
      w.idleness * idleness +
      w.expertise * expertise -
      w.pairPenalty * pairPenalty -
      w.fairness * fairness +
      requesterBonus
    );
  }

  private best(candidates: Candidate[]): AgentRow | undefined {
    candidates.sort(
      (a, b) =>
        b.score - a.score ||
        (a.agent.last_assigned_at ?? -1) - (b.agent.last_assigned_at ?? -1) ||
        a.agent.id.localeCompare(b.agent.id),
    );
    return candidates[0]?.agent;
  }

  // ---------------------------------------------------------------------------
  // Author assignment — spec §9.2
  // ---------------------------------------------------------------------------

  private assignAuthor(taskId: number): void {
    const task = this.db.tasks.require(taskId);
    if (task.state !== 'QUEUED' || this.hasPendingOpen(task.id)) return;
    const requester = this.db.agents.require(task.requester_agent_id);
    let chosen: AgentRow | undefined;
    if (task.mode === 'own') {
      const a = requester;
      if (this.isOnline(a) && a.paused === 0 && !this.isRateLimited(a) && this.hasSlot(a) && !this.backedOff(a.id) && this.canAdmitAuthor(task, a.id)) chosen = a;
    } else {
      const candidates: Candidate[] = [];
      for (const a of this.db.agents.all()) {
        if (!this.isOnline(a) || this.isRateLimited(a) || !this.hasSlot(a) || this.backedOff(a.id)) continue;
        const own = a.owner_name === requester.owner_name;
        const estimate = estimateAuthor(a, this.config.costEstimate);
        if (own ? a.paused !== 0 : !this.mayLend(a) || budgetRemaining(this.db, a, this.now(), this.config.dayBoundaryTz) < estimate) continue;
        if (!this.canAdmitAuthor(task, a.id)) continue;
        candidates.push({ agent: a, score: this.score(a, task, 'author', own, estimate) });
      }
      chosen = this.best(candidates);
    }
    if (chosen === undefined) return;
    const sid = this.pickSession(chosen, taskFiles(task), 'author');
    if (sid !== null) this.bindAuthor(task, sid);
    else this.openSession(chosen.id, 'author', { taskId: task.id });
  }

  /** QUEUED → AUTHORING on a concrete idle session. */
  private bindAuthor(task: TaskRow, sid: string): void {
    this.db.withTx(() => {
      const session = this.db.sessions.require(sid);
      const continueExisting = task.branch !== null;
      this.db.tasks.update(task.id, {
        author_agent_id: session.agent_id,
        author_session_id: sid,
        branch: task.branch ?? `${this.config.repo.branchPrefix}${task.id}`,
      });
      this.options.locks.lockSession(sid, 'task', String(task.id), 'author');
      this.touchAgent(session.agent_id);
      transition(this.db, task.id, 'AUTHORING', { reason: 'author_assigned', actor: 'leader', data: { agentId: session.agent_id, sid }, at: this.now() });
      this.options.handlers.sendAuthor(task.id, 'start', continueExisting);
    });
  }

  // ---------------------------------------------------------------------------
  // Reviewer assignment — spec §9.3
  // ---------------------------------------------------------------------------

  private assignReviewer(taskId: number): void {
    const task = this.db.tasks.require(taskId);
    if (task.state !== 'AWAITING_REVIEWER' || this.hasPendingOpen(task.id) || task.author_agent_id === null) return;
    const candidates = this.eligibleReviewers(task, task.author_agent_id).filter(({ agent }) => this.hasSlot(agent));
    // Agents whose earlier review of this task was abandoned (crash, invalid output, rate limit, …) are a last resort.
    const dropped = new Set(this.db.conversations.find({ task_id: task.id, state: 'abandoned' }).map((c) => c.reviewer_agent_id));
    const fresh = candidates.filter((c) => !dropped.has(c.agent.id));
    const ranked = (fresh.length > 0 ? fresh : candidates).sort(
      (a, b) => b.score - a.score || (a.agent.last_assigned_at ?? -1) - (b.agent.last_assigned_at ?? -1) || a.agent.id.localeCompare(b.agent.id),
    );
    const remaining = this.pendingReviewDemands().filter((demand) => demand.task.id !== task.id);
    const chosen = ranked.find(({ agent }) => this.canMatchReviewDemands(remaining, agent.id)) ?? ranked[0];
    if (chosen === undefined) {
      const waited = this.now() - task.state_entered_at;
      const key = `no_reviewer:${task.id}:${task.state_entered_at}`;
      if (waited >= this.config.timeouts.noReviewerNotifyAfterSec * 1000 && !this.notified.has(key)) {
        this.notified.add(key);
        this.options.onAttention?.(task.id, 'no_reviewer', 'No eligible reviewer is available. Wait, approve manually, or cancel.');
      }
      return;
    }
    const sid = this.pickSession(chosen.agent, taskFiles(task), 'reviewer');
    if (sid !== null) this.bindReviewer(task, sid);
    else this.openSession(chosen.agent.id, 'reviewer', { taskId: task.id });
  }

  /** Agents eligible to review this task, without filtering out agents that are currently full. */
  private eligibleReviewers(task: TaskRow, authorAgentId: string): Candidate[] {
    const requesterOwner = this.ownerOf(task.requester_agent_id);
    const candidates: Candidate[] = [];
    for (const agent of this.db.agents.all()) {
      if (agent.id === authorAgentId || !this.isOnline(agent) || this.isRateLimited(agent) || this.backedOff(agent.id)) continue;
      const own = agent.owner_name === requesterOwner;
      const estimate = estimateReview(agent, task, this.config.costEstimate);
      if (own ? agent.paused !== 0 : !this.mayLend(agent) || budgetRemaining(this.db, agent, this.now(), this.config.dayBoundaryTz) < estimate) continue;
      candidates.push({ agent, score: this.score(agent, task, 'reviewer', own, estimate) });
    }
    return candidates;
  }

  /**
   * Keep enough free reviewer slots to match every task already in the author/review queue, plus
   * the author we are about to admit. Each author lock lasts through review, so assigning authors
   * without this check can consume every slot before any review starts.
   */
  private canAdmitAuthor(task: TaskRow, authorAgentId: string): boolean {
    return this.canMatchReviewDemands([...this.pendingReviewDemands(), { task, authorAgentId }], authorAgentId);
  }

  private pendingReviewDemands(): { task: TaskRow; authorAgentId: string }[] {
    return this.db.tasks.all().flatMap((task) => {
      const needsReviewer = ['AUTHORING', 'SYNCING', 'AWAITING_REVIEWER'].includes(task.state) ||
        (task.state === 'PAUSED' && ['AUTHORING', 'SYNCING', 'AWAITING_REVIEWER'].includes(task.paused_from_state ?? ''));
      return needsReviewer && task.author_agent_id !== null ? [{ task, authorAgentId: task.author_agent_id }] : [];
    });
  }

  /** Capacity-aware bipartite matching prevents a flexible task from taking the sole reviewer slot another task needs. */
  private canMatchReviewDemands(
    demands: { task: TaskRow; authorAgentId: string }[],
    consumeAgentId?: string,
  ): boolean {
    const eligible = demands
      .map(({ task, authorAgentId }) => ({
        task,
        reviewers: this.eligibleReviewers(task, authorAgentId).map(({ agent }) => agent.id),
      }))
      // Tasks with no eligible reviewer cannot be helped by reserving capacity; keep their existing
      // behavior (author, then surface the no-reviewer attention state).
      .filter(({ reviewers }) => reviewers.length > 0)
      .sort((a, b) => a.reviewers.length - b.reviewers.length);
    if (eligible.length === 0) return true;

    const slots: string[] = [];
    for (const agent of this.db.agents.all()) {
      // Reviewer sessions are temporary demand on a slot: once that review finishes, the slot
      // becomes available to the next task. Author/directive locks are the work that can starve
      // reviews if every session is consumed, so only those locks reduce projected capacity.
      const occupied = this.db.sessions.find({ agent_id: agent.id, state: 'locked' })
        .filter((session) => session.lock_role !== 'reviewer').length +
        this.db.sessions.find({ agent_id: agent.id, state: 'opening' })
          .filter((session) => session.profile !== 'reviewer').length;
      const free = Math.max(0, agent.max_sessions - occupied - (agent.id === consumeAgentId ? 1 : 0));
      for (let i = 0; i < free; i += 1) slots.push(agent.id);
    }
    const assigned = new Array<number>(slots.length).fill(-1);
    const match = (demandIndex: number, visited: Set<number>): boolean => {
      const reviewers = new Set(eligible[demandIndex]!.reviewers);
      for (let slot = 0; slot < slots.length; slot += 1) {
        if (!reviewers.has(slots[slot]!) || visited.has(slot)) continue;
        visited.add(slot);
        if (assigned[slot] === -1 || match(assigned[slot]!, visited)) {
          assigned[slot] = demandIndex;
          return true;
        }
      }
      return false;
    };
    return eligible.every((_, index) => match(index, new Set()));
  }

  /** AWAITING_REVIEWER → IN_REVIEW with a new conversation (T7). */
  private bindReviewer(task: TaskRow, sid: string): void {
    this.db.withTx(() => {
      const current = this.db.tasks.require(task.id);
      if (current.author_agent_id === null || current.author_session_id === null) throw new Error('task has no author');
      const session = this.db.sessions.require(sid);
      this.db.tasks.update(task.id, { turn_retries: 0 });
      const conversationId = randomUUID();
      this.db.conversations.insert({
        id: conversationId,
        task_id: task.id,
        author_session_id: current.author_session_id,
        author_agent_id: current.author_agent_id,
        reviewer_session_id: sid,
        reviewer_agent_id: session.agent_id,
        state: 'active',
        created_at: this.now(),
      });
      this.options.locks.lockSession(sid, 'task', String(task.id), 'reviewer');
      this.touchAgent(session.agent_id);
      transition(this.db, task.id, 'IN_REVIEW', { reason: 'reviewer_assigned', actor: 'leader', data: { agentId: session.agent_id, sid, conversationId }, at: this.now() });
      this.options.handlers.sendReview(task.id, conversationId, 'start');
    });
  }

  // ---------------------------------------------------------------------------
  // Directives — spec §13
  // ---------------------------------------------------------------------------

  private runDirective(directiveId: string): void {
    const d = this.db.directives.require(directiveId);
    if (d.state !== 'queued' || this.hasPendingOpen(undefined, d.id)) return;
    const agent = this.db.agents.get(d.agent_id);
    if (agent === undefined || !this.isOnline(agent) || this.isRateLimited(agent) || !this.hasSlot(agent) || this.backedOff(agent.id)) return;
    if (agent.owner_name !== d.requester && !this.mayLend(agent)) return;
    const sid = this.pickSession(agent, [], 'directive');
    if (sid !== null) this.bindDirective(d.id, sid);
    else this.openSession(agent.id, 'directive', { directiveId: d.id });
  }

  /** Locks `sid` to the directive and sends directive.run (also used by POST /api/directives with a sessionId). */
  bindDirective(directiveId: string, sid: string): void {
    this.db.withTx(() => {
      const d = this.db.directives.require(directiveId);
      this.db.directives.update(d.id, { state: 'running', session_id: sid });
      this.options.locks.lockSession(sid, 'directive', d.id, 'directive');
      const agent = this.db.agents.require(d.agent_id);
      this.options.locks.sendToSession(sid, {
        type: 'directive.run',
        sid,
        directiveId: d.id,
        requester: d.requester,
        text: d.text,
        estimated: Math.round(agent.cost_ratio_ema * this.config.costEstimate.baseTokens),
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Sessions — spec §9.4
  // ---------------------------------------------------------------------------

  /** An idle session of `profile` worth reusing, or null to open a new one. Nodes fix a session's profile at open. */
  private pickSession(agent: AgentRow, files: string[], profile: SessionProfile): string | null {
    const maxContext = this.config.scheduler.sessionReuseMaxContextPct * agent.context_window;
    let best: { sid: string; score: number } | null = null;
    for (const s of this.db.sessions.find({ agent_id: agent.id, state: 'idle', profile })) {
      if (s.context_tokens >= maxContext) continue;
      // A session keeps the tool profile it was opened with (reviewers are read-only); never reuse it for another role.
      const opened = this.sessionProfile(s.id);
      if (opened !== undefined && opened !== profile) continue;
      // A never-used session is as good as a new one, so it always qualifies (at the threshold).
      const fresh = s.files === '[]' && s.task_history === '[]';
      const score = fresh ? this.config.scheduler.sessionReuseMinAffinity : overlap(files, JSON.parse(s.files) as string[]);
      if (best === null || score > best.score) best = { sid: s.id, score };
    }
    if (best === null) return null;
    // A fresh session beats reusing an unrelated one, except when there is nothing to compare (directives, first submissions).
    return files.length === 0 || best.score >= this.config.scheduler.sessionReuseMinAffinity ? best.sid : null;
  }

  /** The profile a session was opened with (from its session.open request); undefined for sessions without one. */
  private sessionProfile(sid: string): SessionProfile | undefined {
    const req = this.db.openRequestFor(sid);
    if (req === undefined) return undefined;
    return ((JSON.parse(req.payload) as CmdFrame).cmd as { profile?: SessionProfile }).profile;
  }

  private openSession(agentId: string, profile: SessionProfile, ref: { taskId?: number; directiveId?: string }): void {
    this.db.withTx(() => {
      const sid = randomUUID();
      const at = this.now();
      this.db.sessions.insert({ id: sid, agent_id: agentId, state: 'opening', profile, created_at: at, last_used_at: at });
      const frame = this.options.locks.sendToAgent(agentId, { type: 'session.open', sid, profile });
      // Pending assignment lives on the session.open row (issue #9).
      this.db.messages.update(frame.msgId, { task_id: ref.taskId ?? null, directive_id: ref.directiveId ?? null });
    });
  }

  private hasPendingOpen(taskId?: number, directiveId?: string): boolean {
    for (const s of this.db.sessions.find({ state: 'opening' })) {
      const req = this.db.openRequestFor(s.id);
      if (req === undefined) continue;
      if (taskId !== undefined && req.task_id === taskId) return true;
      if (directiveId !== undefined && req.directive_id === directiveId) return true;
    }
    return false;
  }

  private closeIdleSessions(): void {
    const cutoff = this.now() - this.config.timeouts.idleSessionTtlMin * 60_000;
    for (const s of this.db.sessions.find({ state: 'idle' })) {
      if (s.last_used_at >= cutoff) continue;
      const agent = this.db.agents.get(s.agent_id);
      if (agent === undefined || !this.isOnline(agent)) continue;
      this.guard(`close ${s.id}`, () =>
        this.db.withTx(() => {
          this.db.sessions.update(s.id, { state: 'closing' });
          this.options.locks.sendToAgent(s.agent_id, { type: 'session.close', sid: s.id });
        }),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Liveness — spec §10.3–§10.5
  // ---------------------------------------------------------------------------

  private expire(): void {
    const now = this.now();
    for (const a of this.db.agents.find({ status: 'online' })) {
      if (a.last_heartbeat_at === null || now - a.last_heartbeat_at > this.config.timeouts.agentOfflineAfterSec * 1000) {
        this.db.agents.update(a.id, { status: 'offline' });
      }
    }
    for (const a of this.db.agents.all()) {
      if (a.rate_limited_until !== null && a.rate_limited_until <= now) this.db.agents.update(a.id, { rate_limited_until: null });
    }
    for (const s of this.db.sessions.find({ state: 'opening' })) {
      if (now - s.created_at > SESSION_OPEN_TIMEOUT_MS) {
        this.guard(`open timeout ${s.id}`, () => this.options.locks.releaseSession(s.id, 'lost'));
        this.openBackoff.set(s.agent_id, now + OPEN_FAILURE_BACKOFF_MS);
      }
    }
    for (const s of this.db.sessions.find({ state: 'locked' })) {
      if (s.lease_expires_at !== null && s.lease_expires_at < now) {
        this.guard(`lease ${s.id}`, () => this.options.handlers.sessionLost(s, 'lease_expired'));
      }
    }
    this.expireTurns();
    for (const task of this.db.tasks.find({ state: 'PAUSED' })) this.guard(`paused ${task.id}`, () => this.handlePaused(task.id));
  }

  /** Backstop for turns the Node never answered (spec §10.3 last bullet). */
  private expireTurns(): void {
    const limit = this.config.timeouts.turnTimeoutSec * 1000 + TURN_TIMEOUT_GRACE_MS;
    for (const s of this.db.sessions.find({ state: 'locked' })) {
      const cmd = this.db.latestTurnCommand(s.id);
      if (cmd === undefined || this.now() - cmd.created_at < limit || this.db.hasReplyTo(cmd.id)) continue;
      const original = (JSON.parse(cmd.payload) as CmdFrame).cmd;
      this.guard(`turn timeout ${cmd.id}`, () =>
        this.db.withTx(() => {
          this.options.locks.sendToSession(s.id, {
            type: 'task.cancel',
            sid: s.id,
            ...('taskId' in original ? { taskId: original.taskId } : {}),
            ...('directiveId' in original ? { directiveId: original.directiveId } : {}),
          });
          this.options.handlers.handle(s.agent_id, {
            type: 'turn.failed',
            inReplyTo: cmd.id,
            sid: s.id,
            ...('taskId' in original ? { taskId: original.taskId } : {}),
            ...('directiveId' in original ? { directiveId: original.directiveId } : {}),
            code: 'TIMEOUT',
            message: 'no result from the Node within the turn timeout',
          });
        }),
      );
    }
  }

  private handlePaused(taskId: number): void {
    const task = this.db.tasks.require(taskId);
    if (task.state !== 'PAUSED' || task.pause_reason === 'human' || this.hasPendingOpen(task.id)) return;
    const from = task.paused_from_state;
    if (from === null || from === 'PAUSED' || isTerminal(from)) return;
    const author = task.author_agent_id === null ? undefined : this.db.agents.get(task.author_agent_id);
    const authorUp = author !== undefined && this.isOnline(author) && !this.isRateLimited(author);
    if (!['AUTHORING', 'SYNCING'].includes(from)) {
      // Paused while the author wasn't needed: resume as soon as allowed.
      transition(this.db, task.id, from as TaskState, { reason: 'resumed', actor: 'leader', at: this.now() });
      return;
    }
    if (authorUp && author !== undefined) {
      const session = task.author_session_id === null ? undefined : this.db.sessions.get(task.author_session_id);
      const alive = session?.state === 'locked' && session.lock_ref === String(task.id) && session.lock_role === 'author';
      if (alive) this.resumeAuthor(task.id);
      else if (this.hasSlot(author) && !this.backedOff(author.id)) {
        const sid = this.pickSession(author, taskFiles(task), 'author');
        if (sid !== null) this.replaceAuthorSession(task, sid);
        else this.openSession(author.id, 'author', { taskId: task.id });
      }
      return;
    }
    if (this.now() - task.state_entered_at < this.config.timeouts.authorReconnectGraceSec * 1000) return;
    if (task.mode === 'pool') {
      this.requeue(task.id);
    } else {
      const key = `author_unavailable:${task.id}:${task.state_entered_at}`;
      if (!this.notified.has(key)) {
        this.notified.add(key);
        this.options.onAttention?.(task.id, 'author_unavailable', 'The author agent is unavailable. Reassign to the pool, wait, or cancel.');
      }
    }
  }

  /** Human resume (T33): hand the task back to normal PAUSED handling, which resumes as soon as possible. */
  resumeFromHumanPause(taskId: number): void {
    this.db.withTx(() => {
      const task = this.db.tasks.require(taskId);
      if (task.state !== 'PAUSED') throw new Error('task is not paused');
      this.db.tasks.update(taskId, { pause_reason: 'resume_requested', state_entered_at: this.now() });
      this.handlePaused(taskId);
    });
  }

  /** PAUSED → paused_from_state on the same, still-locked author session (T23). */
  private resumeAuthor(taskId: number): void {
    this.db.withTx(() => {
      const task = this.db.tasks.require(taskId);
      const from = task.paused_from_state as 'AUTHORING' | 'SYNCING';
      transition(this.db, taskId, from, { reason: 'author_available', actor: 'leader', at: this.now() });
      this.reissueAuthorCommand(taskId, from);
    });
  }

  /** A PAUSED task that handlePaused would resume on a new session of this agent (never one a human paused). */
  private awaitsAuthorSession(task: TaskRow, agentId: string): boolean {
    return task.state === 'PAUSED' && task.pause_reason !== 'human' && task.author_agent_id === agentId
      && (task.paused_from_state === 'AUTHORING' || task.paused_from_state === 'SYNCING');
  }

  /** The author's session was lost: bind a new session on the same agent, drop the old pairing, resume (spec §10.4). */
  private replaceAuthorSession(task: TaskRow, sid: string): void {
    this.db.withTx(() => {
      const current = this.db.tasks.require(task.id);
      const from = current.paused_from_state as 'AUTHORING' | 'SYNCING';
      this.abandonConversations(current.id, 'author_session_replaced');
      if (current.author_session_id !== null) {
        const old = this.db.sessions.get(current.author_session_id);
        if (old?.state === 'locked') this.options.locks.releaseSession(old.id, 'lost');
      }
      this.db.tasks.update(current.id, { author_session_id: sid });
      this.options.locks.lockSession(sid, 'task', String(current.id), 'author');
      transition(this.db, current.id, from, { reason: 'author_session_replaced', actor: 'leader', data: { sid }, at: this.now() });
      if (from === 'SYNCING') this.options.handlers.sendAuthor(current.id, 'sync');
      else this.options.handlers.sendAuthor(current.id, 'start', current.head_commit !== null || current.branch !== null);
    });
  }

  private reissueAuthorCommand(taskId: number, state: 'AUTHORING' | 'SYNCING'): void {
    const task = this.db.tasks.require(taskId);
    if (state === 'SYNCING') {
      this.options.handlers.sendAuthor(taskId, 'sync');
      return;
    }
    const openBlocking = this.db.issues.find({ task_id: taskId, status: 'open', severity: 'blocking' });
    if (openBlocking.length > 0) this.options.handlers.sendAuthor(taskId, 'revise');
    else this.options.handlers.sendAuthor(taskId, 'start', task.head_commit !== null);
  }

  /** Grace elapsed in pool mode (T24): drop the author and let anyone continue the branch. */
  private requeue(taskId: number): void {
    this.db.withTx(() => {
      const task = this.db.tasks.require(taskId);
      this.abandonConversations(taskId, 'author_requeued');
      if (task.author_session_id !== null) {
        const s = this.db.sessions.get(task.author_session_id);
        if (s?.state === 'locked') this.options.locks.releaseSession(s.id, 'lost');
      }
      this.db.tasks.update(taskId, { author_agent_id: null, author_session_id: null });
      transition(this.db, taskId, 'QUEUED', { reason: 'author_unavailable_requeued', actor: 'leader', at: this.now() });
    });
  }

  private abandonConversations(taskId: number, reason: string): void {
    for (const c of this.db.conversations.find({ task_id: taskId, state: 'active' })) {
      this.db.conversations.update(c.id, { state: 'abandoned', ended_at: this.now() });
      const reviewer = this.db.sessions.get(c.reviewer_session_id);
      if (reviewer?.state === 'locked' && reviewer.lock_ref === String(taskId)) this.options.locks.releaseSession(reviewer.id, 'idle');
      this.log.info({ taskId, conversationId: c.id, reason }, 'conversation abandoned');
    }
  }

  // ---------------------------------------------------------------------------

  private byPriority(states: string[]): TaskRow[] {
    const now = this.now();
    const aging = this.config.scheduler.agingMinutesPerPriorityPoint * 60_000;
    return this.db.tasks
      .all()
      .filter((t) => states.includes(t.state))
      .map((t) => ({ t, p: t.priority + (now - t.state_entered_at) / aging }))
      .sort((a, b) => b.p - a.p || a.t.created_at - b.t.created_at)
      .map(({ t }) => t);
  }

  private touchAgent(agentId: string): void {
    this.db.agents.update(agentId, { last_assigned_at: this.now() });
  }

  private guard(label: string, fn: () => void): void {
    try {
      fn();
    } catch (error) {
      this.log.error({ err: error, label }, 'scheduler step failed');
    }
  }
}
