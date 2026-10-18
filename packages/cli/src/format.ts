import type { AgentView, DirectiveView, TaskDetail, TaskState, TaskView, TaskWaitReason } from '@quorum/protocol';

export const STATE_LABEL: Record<TaskState, string> = {
  QUEUED: 'queued',
  AUTHORING: 'authoring',
  AWAITING_REVIEWER: 'waiting for a reviewer',
  IN_REVIEW: 'in review',
  MERGE_QUEUED: 'queued for merge',
  MERGING: 'merging',
  SYNCING: 'merging latest main',
  PAUSED: 'paused',
  ESCALATED: 'needs a human decision',
  MERGED: 'merged',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
};

/** What a caller should do next: `pending` keeps waiting; the others are final for `quorum task wait`. */
export type Outcome = 'merged' | 'needs_human' | 'failed' | 'pending';

export function outcomeOf(task: TaskView): Outcome {
  if (task.state === 'MERGED') return 'merged';
  if (task.state === 'CANCELLED' || task.state === 'FAILED') return 'failed';
  if (task.state === 'ESCALATED') return 'needs_human';
  // A human pause never resumes on its own; rate-limit and other pauses do.
  if (task.state === 'PAUSED' && task.pauseReason === 'human') return 'needs_human';
  return 'pending';
}

/** The author's question when it is blocked on a decision (answer it with `quorum task answer`). */
export function blockedQuestion(task: TaskView): string | null {
  const r = task.escalationReason;
  return r?.startsWith('author_blocked:') ? r.slice('author_blocked:'.length).trim() : null;
}

export interface TaskSummary {
  id: number;
  title: string;
  state: TaskState;
  outcome: Outcome;
  reviewRound: number;
  requester: string;
  author: string | null;
  reviewers: string[];
  branch: string | null;
  headCommit: string | null;
  mergedCommit: string | null;
  question: string | null;
  escalationReason: string | null;
  pauseReason: string | null;
  /** Why the task waits for an agent (QUEUED / AWAITING_REVIEWER only). */
  waitReason: TaskWaitReason | null;
  openIssues: { code: string; severity: string; file: string | null; line: number | null; comment: string }[];
  lastTestOutput: string | null;
  updatedAt: number;
}

/** Compact, stable JSON for scripts and agents (the full detail also carries the message transcript). */
export function summarize(detail: TaskDetail): TaskSummary {
  const t = detail.task;
  return {
    id: t.id,
    title: t.title,
    state: t.state,
    outcome: outcomeOf(t),
    reviewRound: t.reviewRound,
    requester: t.requesterOwner,
    author: t.authorAgentId,
    reviewers: [...new Set(detail.conversations.map((c) => c.reviewerAgentId))],
    branch: t.branch,
    headCommit: t.headCommit,
    mergedCommit: t.mergedCommit,
    question: blockedQuestion(t),
    escalationReason: t.escalationReason,
    pauseReason: t.pauseReason,
    waitReason: t.waitReason ?? null,
    openIssues: detail.issues
      .filter((i) => i.status === 'open')
      .map((i) => ({ code: i.code, severity: i.severity, file: i.file, line: i.line, comment: i.comment })),
    lastTestOutput: t.lastTestOutput,
    updatedAt: t.updatedAt,
  };
}

export function formatSummary(s: TaskSummary): string {
  const rows: [string, string][] = [['state', `${STATE_LABEL[s.state]}${s.reviewRound > 0 ? ` (review round ${s.reviewRound})` : ''}`]];
  if (s.author !== null) rows.push(['author', s.author]);
  if (s.reviewers.length > 0) rows.push(['reviewer', s.reviewers.join(', ')]);
  if (s.branch !== null) rows.push(['branch', s.branch]);
  if (s.mergedCommit !== null) rows.push(['merged', s.mergedCommit.slice(0, 7)]);
  if (s.question !== null) rows.push(['question', s.question]);
  else if (s.escalationReason !== null) rows.push(['decision', s.escalationReason]);
  if (s.pauseReason !== null && s.state === 'PAUSED') rows.push(['paused', s.pauseReason]);
  if (s.waitReason !== null && (s.state === 'QUEUED' || s.state === 'AWAITING_REVIEWER')) rows.push(['waiting', formatWait(s.waitReason)]);
  const lines = [`#${s.id} ${s.title}`, ...rows.map(([k, v]) => `  ${k.padEnd(9)}${v}`)];
  if (s.openIssues.length > 0) {
    lines.push('  open issues:');
    for (const i of s.openIssues) {
      const where = i.file === null ? '' : ` ${i.file}${i.line !== null ? `:${i.line}` : ''}`;
      lines.push(`    ${i.code} [${i.severity}]${where}: ${i.comment}`);
    }
  }
  if (s.outcome === 'needs_human') {
    lines.push(s.question !== null ? `  answer with: quorum task answer ${s.id} "<answer>"` : '  a person must decide in the Quorum app (approve, send back or cancel)');
  }
  if (s.state === 'FAILED' && s.lastTestOutput !== null) lines.push('  last test output:', indent(s.lastTestOutput.trimEnd(), 4));
  return lines.join('\n');
}

/** e.g. `agents busy (bob-claude); next: wait`. */
export function formatWait(w: TaskWaitReason): string {
  const who = w.agentId !== null ? ` (${w.agentId})` : '';
  return `${w.code.replace(/_/g, ' ')}${who}; next: ${w.nextStep.replace(/_/g, ' ')}`;
}

export function formatTaskLine(t: TaskView): string {
  return `#${String(t.id).padEnd(5)} ${STATE_LABEL[t.state].padEnd(24)} ${t.title}`;
}

export function formatAgents(agents: AgentView[]): string {
  if (agents.length === 0) return 'No agents.';
  const rows = agents.map((a) => {
    const limited = a.rateLimitedUntil !== null && a.rateLimitedUntil > Date.now();
    const status = a.status !== 'online' ? 'offline' : limited ? 'rate-limited' : a.paused ? 'paused' : a.lendMode === 'never' ? 'own work only' : 'available';
    return [a.id, a.ownerName, status, `${a.lockedSessions}/${a.maxSessions} busy`, a.tags.join(',')];
  });
  const header = ['AGENT', 'OWNER', 'STATUS', 'SESSIONS', 'TAGS'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  return [header, ...rows].map((r) => r.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd()).join('\n');
}

export function formatDirective(d: DirectiveView): string {
  if (d.state === 'done') return d.resultText ?? '';
  if (d.state === 'failed') return `failed: ${d.error ?? 'unknown error'}`;
  return `directive ${d.id} is ${d.state}`;
}

function indent(text: string, n: number): string {
  return text
    .split('\n')
    .map((l) => ' '.repeat(n) + l)
    .join('\n');
}
