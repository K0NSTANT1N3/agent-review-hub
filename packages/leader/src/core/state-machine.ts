import type { AgentRow, LeaderDb, SessionRow, TaskRow } from '../db/repo.js';

import { TASK_STATES, type TaskState } from '@quorum/protocol';
export { TASK_STATES };
export type { TaskState };

export const NON_TERMINAL_STATES = [
  'QUEUED', 'AUTHORING', 'AWAITING_REVIEWER', 'IN_REVIEW', 'MERGE_QUEUED',
  'MERGING', 'SYNCING', 'PAUSED', 'ESCALATED',
] as const satisfies readonly TaskState[];

const PAUSABLE_STATES = NON_TERMINAL_STATES.filter((state) => state !== 'PAUSED');
type TransitionId = `T${number}`;
type TransitionTarget = readonly TaskState[] | 'paused_from_state';

interface TransitionRule {
  readonly id: TransitionId;
  readonly from: readonly TaskState[];
  readonly to: TransitionTarget;
}

export const TRANSITIONS = [
  { id: 'T1', from: ['QUEUED'], to: ['AUTHORING'] },
  { id: 'T2', from: ['AUTHORING'], to: ['AWAITING_REVIEWER'] },
  { id: 'T3', from: ['AUTHORING'], to: ['IN_REVIEW'] },
  { id: 'T4', from: ['AUTHORING'], to: ['AUTHORING'] },
  { id: 'T5', from: ['AUTHORING'], to: ['ESCALATED'] },
  { id: 'T6', from: ['AUTHORING'], to: ['ESCALATED'] },
  { id: 'T7', from: ['AWAITING_REVIEWER'], to: ['IN_REVIEW'] },
  { id: 'T8', from: ['IN_REVIEW'], to: ['MERGE_QUEUED'] },
  { id: 'T9', from: ['IN_REVIEW'], to: ['AUTHORING'] },
  { id: 'T10', from: ['IN_REVIEW'], to: ['ESCALATED'] },
  { id: 'T11', from: ['IN_REVIEW'], to: ['AWAITING_REVIEWER'] },
  { id: 'T12', from: ['AUTHORING'], to: ['AUTHORING'] },
  { id: 'T13', from: ['MERGE_QUEUED'], to: ['MERGING'] },
  { id: 'T14', from: ['MERGING'], to: ['MERGED'] },
  { id: 'T15', from: ['MERGING'], to: ['SYNCING'] },
  { id: 'T16', from: ['MERGING'], to: ['ESCALATED'] },
  { id: 'T17', from: ['MERGING'], to: ['AUTHORING'] },
  { id: 'T18', from: ['MERGING'], to: ['ESCALATED'] },
  { id: 'T19', from: ['SYNCING'], to: ['MERGE_QUEUED'] },
  { id: 'T20', from: ['SYNCING'], to: ['IN_REVIEW', 'AWAITING_REVIEWER'] },
  { id: 'T21', from: ['SYNCING'], to: ['AUTHORING', 'ESCALATED'] },
  { id: 'T22', from: ['AUTHORING', 'SYNCING'], to: ['PAUSED'] },
  { id: 'T23', from: ['PAUSED'], to: 'paused_from_state' },
  { id: 'T24', from: ['PAUSED'], to: ['QUEUED'] },
  { id: 'T25', from: ['PAUSED'], to: ['PAUSED'] },
  { id: 'T26', from: ['ESCALATED'], to: ['MERGE_QUEUED'] },
  { id: 'T27', from: ['ESCALATED', 'IN_REVIEW', 'AWAITING_REVIEWER'], to: ['AUTHORING'] },
  { id: 'T28', from: NON_TERMINAL_STATES, to: ['CANCELLED'] },
  { id: 'T29', from: NON_TERMINAL_STATES, to: ['FAILED'] },
  { id: 'T30', from: ['IN_REVIEW', 'AWAITING_REVIEWER'], to: ['MERGE_QUEUED'] },
  { id: 'T31', from: ['IN_REVIEW'], to: ['AWAITING_REVIEWER'] },
  { id: 'T32', from: PAUSABLE_STATES, to: ['PAUSED'] },
  { id: 'T33', from: ['PAUSED'], to: 'paused_from_state' },
] as const satisfies readonly TransitionRule[];

export class IllegalTransitionError extends Error {
  constructor(readonly taskId: number, readonly from: string, readonly to: string) {
    super(`Illegal task transition ${taskId}: ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function isTaskState(value: string): value is TaskState {
  return (TASK_STATES as readonly string[]).includes(value);
}

export function isTerminal(state: string): boolean {
  return state === 'MERGED' || state === 'CANCELLED' || state === 'FAILED';
}

export function allowedTransitionIds(task: Pick<TaskRow, 'state' | 'paused_from_state'>, to: TaskState): TransitionId[] {
  if (!isTaskState(task.state) || !isTaskState(to)) return [];
  return (TRANSITIONS as readonly TransitionRule[])
    .filter((rule) => (rule.from as readonly string[]).includes(task.state))
    .filter((rule) => rule.to === 'paused_from_state'
      ? to === task.paused_from_state && to !== 'PAUSED' && !isTerminal(to)
      : rule.to.includes(to))
    .map((rule) => rule.id);
}

export interface TransitionOptions {
  reason: string;
  actor: string;
  data?: Record<string, unknown>;
  at?: number;
  pause?: { from: 'AUTHORING' | 'SYNCING'; reason: string };
}

export function transition(db: LeaderDb, taskId: number, to: TaskState, options: TransitionOptions): TaskRow {
  return db.withTx(() => {
    const task = db.tasks.require(taskId);
    const allowed = allowedTransitionIds(task, to);
    if (!isTaskState(task.state) || !isTaskState(to) || allowed.length === 0) {
      throw new IllegalTransitionError(taskId, task.state, to);
    }
    if (options.pause !== undefined && (to !== 'PAUSED' || allowedTransitionIds(task, options.pause.from).length === 0)) {
      throw new IllegalTransitionError(taskId, task.state, options.pause.from);
    }
    if (options.reason.trim() === '' || options.actor.trim() === '') {
      throw new TypeError('A transition requires a reason and actor');
    }
    const at = options.at ?? Date.now();
    if (!Number.isSafeInteger(at) || at < 0) throw new TypeError('Invalid transition timestamp');
    let pausedFrom = task.paused_from_state;
    let pauseReason = task.pause_reason;
    if (to === 'PAUSED' && options.pause !== undefined) {
      pausedFrom = options.pause.from;
      pauseReason = options.pause.reason;
    } else if (to === 'PAUSED' && task.state !== 'PAUSED') {
      pausedFrom = task.state;
      pauseReason = options.reason;
    } else if (to !== 'PAUSED') {
      pausedFrom = null;
      pauseReason = null;
    }
    const updated = db.tasks.update(taskId, {
      state: to, updated_at: at, state_entered_at: at,
      paused_from_state: pausedFrom, pause_reason: pauseReason,
    });
    db.taskEvents.insert({
      task_id: taskId, from_state: task.state, to_state: to,
      reason: options.reason, actor: options.actor,
      data: JSON.stringify(options.data ?? {}), at,
    });
    return updated;
  });
}

/**
 * MERGING → MERGE_QUEUED is a named, audited recovery operation (spec §8.2 clarifications, L9),
 * deliberately not an ordinary state-machine edge: startup recovery and transient merge failures.
 */
export function requeueMerge(db: LeaderDb, taskId: number, options: Omit<TransitionOptions, 'pause'> & { at: number }): TaskRow {
  return db.withTx(() => {
    const task = db.tasks.require(taskId);
    if (task.state !== 'MERGING') throw new IllegalTransitionError(taskId, task.state, 'MERGE_QUEUED');
    const { at } = options;
    const updated = db.tasks.update(taskId, { state: 'MERGE_QUEUED', state_entered_at: at, updated_at: at });
    db.taskEvents.insert({
      task_id: taskId, from_state: 'MERGING', to_state: 'MERGE_QUEUED',
      reason: options.reason, actor: options.actor, data: JSON.stringify(options.data ?? {}), at,
    });
    if (db.mergeQueue.get(taskId) === undefined) db.mergeQueue.insert({ task_id: taskId, enqueued_at: at });
    return updated;
  });
}

export interface TaskWithAuthor extends TaskRow {
  authorAgent: AgentRow | undefined;
  authorSession: SessionRow | undefined;
}

export type AuthorStateEntry =
  | { to: 'AUTHORING' | 'SYNCING'; pause?: never }
  | { to: 'PAUSED'; pause: { from: 'AUTHORING' | 'SYNCING'; reason: string } };

export function enterAuthorState(task: TaskWithAuthor, intended: 'AUTHORING' | 'SYNCING'): AuthorStateEntry {
  const agent = task.authorAgent;
  const session = task.authorSession;
  const available = agent !== undefined && agent.id === task.author_agent_id && agent.status === 'online' && agent.revoked === 0
    && session !== undefined && session.id === task.author_session_id && session.agent_id === agent.id
    && session.state === 'locked' && session.lock_kind === 'task' && session.lock_ref === String(task.id) && session.lock_role === 'author';
  return available
    ? { to: intended }
    : { to: 'PAUSED', pause: { from: intended, reason: 'author_unavailable' } };
}

export function transitionToAuthorState(db: LeaderDb, taskId: number, intended: 'AUTHORING' | 'SYNCING', options: Omit<TransitionOptions, 'pause'>): TaskRow {
  return db.withTx(() => {
    const task = db.tasks.require(taskId);
    if (!isTaskState(task.state) || allowedTransitionIds(task, intended).length === 0) {
      throw new IllegalTransitionError(taskId, task.state, intended);
    }
    const entry = enterAuthorState({
      ...task,
      authorAgent: task.author_agent_id === null ? undefined : db.agents.get(task.author_agent_id),
      authorSession: task.author_session_id === null ? undefined : db.sessions.get(task.author_session_id),
    }, intended);
    return transition(db, taskId, entry.to, { ...options, ...entry });
  });
}
