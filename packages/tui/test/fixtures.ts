import type { AgentView, IssueView, MessageView, SessionView, TaskDetail, TaskEventView, TaskView, TranscriptSession } from '@quorum/protocol';
import { initialState, type State } from '../src/store.js';

export function taskView(overrides: Partial<TaskView> = {}): TaskView {
  return { id: 12, title: 'Rate-limit failed logins', description: 'Limit failed logins to 5 per 15 minutes.', tags: ['auth'], priority: 1, mode: 'own', requesterAgentId: 'codex@tazo', requesterOwner: 'tazo', authorAgentId: 'codex@tazo', authorSessionId: 'author', state: 'IN_REVIEW', pausedFromState: null, pauseReason: null, escalationReason: null, requireHumanApproval: false, branch: 'quorum/12', baseCommit: '3f2a91c', headCommit: 'c91d5aa', lastReviewedCommit: '8b04e7d', reviewRound: 2, testFixAttempts: 0, syncAttempts: 0, files: ['src/auth/login.ts'], diffLines: 71, lastTestOutput: '42 tests passed', mergedCommit: null, createdAt: 1000, updatedAt: 8000, stateEnteredAt: 7000, approvedAt: null, ...overrides };
}

export function agentView(overrides: Partial<AgentView> = {}): AgentView {
  return { id: 'codex@tazo', ownerName: 'tazo', status: 'online', lastHeartbeatAt: 8000, maxSessions: 2, lendMode: 'always', lendTokensPerDay: 100000, humanIdleSec: 100, paused: false, tags: [], contextWindow: 200000, rateLimitedUntil: null, lockedSessions: 1, idleSessions: 0, lentToday: 2000, budgetRemaining: 98000, trust: 'sandboxed', adapterType: 'codex', detectedAgents: [{ type: 'codex', version: '0.163.0', trust: 'sandboxed' }], ...overrides };
}

export function sessionView(overrides: Partial<SessionView> = {}): SessionView {
  return { id: 'reviewer', agentId: 'claude@bob', state: 'locked', lockKind: 'task', lockRef: '12', lockRole: 'reviewer', leaseExpiresAt: 100000, contextTokens: 4000, files: [], taskHistory: [12], createdAt: 1000, lastUsedAt: 7000, closedAt: null, ...overrides };
}

export function message(overrides: Partial<MessageView> = {}): MessageView {
  return { id: 'start', direction: 'to_node', agentId: 'codex@tazo', sessionId: 'author', taskId: 12, directiveId: null, conversationId: null, seq: null, type: 'author.start', payload: { task: { description: 'Limit failed logins to 5 per 15 minutes.' } }, createdAt: 1000, sentAt: 1000, ackedAt: 1001, ...overrides };
}

export function taskEvent(overrides: Partial<TaskEventView> = {}): TaskEventView {
  return { id: 1, taskId: 12, fromState: 'AUTHORING', toState: 'IN_REVIEW', reason: 'author_submitted', actor: 'leader', data: {}, at: 5000, ...overrides };
}

export function humanIssue(comment = 'Use Redis'): IssueView {
  return { id: 1, taskId: 12, code: 'I1', source: 'human', severity: 'blocking', file: null, line: null, comment, status: 'open', authorResponse: null, authorNote: null, disputeCount: 0, raisedRound: 1, conversationId: null, createdAt: 9000 };
}

export function transcripts(): TranscriptSession[] {
  return [
    { sid: 'author', agentId: 'codex@tazo', profile: 'author', events: [
      { seq: 1, at: 2000, kind: 'tool_call', id: 'read', name: 'read', toolKind: 'read', argsSummary: 'src/auth/login.ts' },
      { seq: 2, at: 2500, kind: 'tool_result', id: 'read', ok: true, output: 'source' },
      { seq: 3, at: 3000, kind: 'text', mode: 'final', messageId: 'reply', text: 'Added a Redis counter. The sixth failed attempt returns 429.' },
      { seq: 4, at: 4000, kind: 'usage', inputTokens: 1000, outputTokens: 200, contextTokens: 4000 },
    ] },
    { sid: 'reviewer', agentId: 'claude@bob', profile: 'reviewer', events: [
      { seq: 1, at: 7000, kind: 'thinking', text: 'Checking TTL behavior.\nChecking the successful login path.' },
      { seq: 2, at: 8000, kind: 'status', text: 'reading src/auth/login.ts' },
    ] },
  ];
}

export function detail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return { task: taskView(), conversations: [{ id: 'conversation', taskId: 12, authorSessionId: 'author', authorAgentId: 'codex@tazo', reviewerSessionId: 'reviewer', reviewerAgentId: 'claude@bob', state: 'active', createdAt: 5000, endedAt: null }], issues: [], events: [taskEvent()], messages: [message(), message({ id: 'submitted', direction: 'from_node', type: 'author.submitted', payload: { headCommit: 'c91d5aa', tests: { passed: true }, summary: 'Reset counter on success; added a test.' }, createdAt: 4500 }), message({ id: 'review', agentId: 'claude@bob', sessionId: 'reviewer', type: 'review.rereview', payload: { round: 2 }, createdAt: 6000 })], ...overrides };
}

export function fixtureState(): State {
  const d = detail();
  return { ...initialState, connection: 'connected', tasks: [d.task], agents: [agentView(), agentView({ id: 'claude@bob', ownerName: 'bob', trust: 'enforced', adapterType: 'claude-code', detectedAgents: [{ type: 'claude-code', version: '2.1.304', trust: 'enforced' }] })], sessions: [sessionView({ id: 'author', agentId: 'codex@tazo', lockRole: 'author' }), sessionView()], data: { 12: { detail: d, messages: d.messages, events: d.events, transcripts: transcripts(), transcriptSupported: true, human: [] } } };
}
