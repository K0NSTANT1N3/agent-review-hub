import type {
  AgentView,
  ConversationView,
  DirectiveView,
  IssueView,
  MessageView,
  SessionView,
  TaskDetail,
  TaskEventView,
  TaskView,
} from '@quorum/protocol';
import { budgetRemaining, lentToday } from '../core/budget.js';
import type {
  AgentRow,
  ConversationRow,
  DirectiveRow,
  IssueRow,
  LeaderDb,
  MessageRow,
  SessionRow,
  TaskEventRow,
  TaskRow,
} from '../db/repo.js';

// DB rows → protocol API views (camelCase, decoded JSON). Shapes are validated by API_ROUTES response schemas.

type V<T> = T;

export function agentView(db: LeaderDb, a: AgentRow, now: number, tz: string): AgentView {
  return {
    id: a.id,
    ownerName: a.owner_name,
    status: a.status as V<AgentView['status']>,
    lastHeartbeatAt: a.last_heartbeat_at,
    maxSessions: a.max_sessions,
    lendMode: a.lend_mode as V<AgentView['lendMode']>,
    lendTokensPerDay: a.lend_tokens_per_day,
    humanIdleSec: a.human_idle_sec,
    paused: a.paused !== 0,
    tags: JSON.parse(a.tags) as string[],
    contextWindow: a.context_window,
    rateLimitedUntil: a.rate_limited_until,
    lockedSessions: db.sessions.find({ agent_id: a.id, state: 'locked' }).length,
    idleSessions: db.sessions.find({ agent_id: a.id, state: 'idle' }).length,
    lentToday: lentToday(db, a.id, now, tz),
    budgetRemaining: budgetRemaining(db, a, now, tz),
  };
}

export function sessionView(s: SessionRow): SessionView {
  return {
    id: s.id,
    agentId: s.agent_id,
    state: s.state as V<SessionView['state']>,
    lockKind: s.lock_kind as V<SessionView['lockKind']>,
    lockRef: s.lock_ref,
    lockRole: s.lock_role as V<SessionView['lockRole']>,
    leaseExpiresAt: s.lease_expires_at,
    contextTokens: s.context_tokens,
    files: JSON.parse(s.files) as string[],
    taskHistory: JSON.parse(s.task_history) as number[],
    createdAt: s.created_at,
    lastUsedAt: s.last_used_at,
    closedAt: s.closed_at,
  };
}

export function taskView(db: LeaderDb, t: TaskRow): TaskView {
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    tags: JSON.parse(t.tags) as string[],
    priority: t.priority,
    mode: t.mode as V<TaskView['mode']>,
    requesterAgentId: t.requester_agent_id,
    requesterOwner: db.agents.get(t.requester_agent_id)?.owner_name ?? t.requester_agent_id,
    authorAgentId: t.author_agent_id,
    authorSessionId: t.author_session_id,
    state: t.state as V<TaskView['state']>,
    pausedFromState: t.paused_from_state as V<TaskView['pausedFromState']>,
    pauseReason: t.pause_reason,
    escalationReason: t.escalation_reason,
    branch: t.branch,
    baseCommit: t.base_commit,
    headCommit: t.head_commit,
    lastReviewedCommit: t.last_reviewed_commit,
    reviewRound: t.review_round,
    testFixAttempts: t.test_fix_attempts,
    syncAttempts: t.sync_attempts,
    files: JSON.parse(t.files) as string[],
    diffLines: t.diff_lines,
    lastTestOutput: t.last_test_output,
    mergedCommit: t.merged_commit,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    stateEnteredAt: t.state_entered_at,
    approvedAt: t.approved_at,
  };
}

export function conversationView(c: ConversationRow): ConversationView {
  return {
    id: c.id,
    taskId: c.task_id,
    authorSessionId: c.author_session_id,
    authorAgentId: c.author_agent_id,
    reviewerSessionId: c.reviewer_session_id,
    reviewerAgentId: c.reviewer_agent_id,
    state: c.state as V<ConversationView['state']>,
    createdAt: c.created_at,
    endedAt: c.ended_at,
  };
}

export function issueView(i: IssueRow): IssueView {
  return {
    id: i.id,
    taskId: i.task_id,
    code: i.code,
    source: i.source as V<IssueView['source']>,
    severity: i.severity as V<IssueView['severity']>,
    file: i.file,
    line: i.line,
    comment: i.comment,
    status: i.status as V<IssueView['status']>,
    authorResponse: i.author_response as V<IssueView['authorResponse']>,
    authorNote: i.author_note,
    disputeCount: i.dispute_count,
    raisedRound: i.raised_round,
    conversationId: i.conversation_id,
    createdAt: i.created_at,
  };
}

export function taskEventView(e: TaskEventRow): TaskEventView {
  return {
    id: e.id,
    taskId: e.task_id,
    fromState: e.from_state as V<TaskEventView['fromState']>,
    toState: e.to_state as V<TaskEventView['toState']>,
    reason: e.reason,
    actor: e.actor,
    data: JSON.parse(e.data) as Record<string, unknown>,
    at: e.at,
  };
}

/** payload is the bare Command/Event, not the stored {kind,msgId,…} frame. */
export function messageView(m: MessageRow): MessageView {
  const frame = JSON.parse(m.payload) as { cmd?: unknown; evt?: unknown };
  return {
    id: m.id,
    direction: m.direction as V<MessageView['direction']>,
    agentId: m.agent_id,
    sessionId: m.session_id,
    taskId: m.task_id,
    directiveId: m.directive_id,
    conversationId: m.conversation_id,
    seq: m.seq,
    type: m.type,
    payload: frame.cmd ?? frame.evt ?? frame,
    createdAt: m.created_at,
    sentAt: m.sent_at,
    ackedAt: m.acked_at,
  };
}

export function directiveView(d: DirectiveRow): DirectiveView {
  return {
    id: d.id,
    requester: d.requester,
    agentId: d.agent_id,
    sessionId: d.session_id,
    text: d.text,
    state: d.state as V<DirectiveView['state']>,
    resultText: d.result_text,
    error: d.error,
    createdAt: d.created_at,
    finishedAt: d.finished_at,
  };
}

export function taskDetail(db: LeaderDb, t: TaskRow): TaskDetail {
  return {
    task: taskView(db, t),
    conversations: db.conversations.find({ task_id: t.id }).map(conversationView),
    issues: db.issues.find({ task_id: t.id }).map(issueView),
    events: db.taskEvents.find({ task_id: t.id }).map(taskEventView),
    messages: db.messagesForTask(t.id).map(messageView),
  };
}
