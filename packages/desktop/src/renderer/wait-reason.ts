import type { TaskView, TaskWaitReason, WaitBlocker } from '@quorum/protocol';

// Text for the Leader's structured wait reasons (issue #51). Pure, so it is unit-tested without a DOM.

export interface WaitText {
  /** One line for task cards. */
  short: string;
  /** What blocks the task, for Task Detail. */
  detail: string;
  /** What someone can do about it; null when waiting is the only option. */
  action: string | null;
  tone: 'muted' | 'warn';
}

const BLOCKER_LABEL: Record<WaitBlocker, string> = {
  offline: 'offline',
  paused: 'paused',
  rate_limited: 'rate-limited',
  busy: 'all sessions busy',
  review_capacity: 'reserving capacity for reviews',
  session_backoff: 'session start failed, retrying',
  not_lending: 'not lending now',
  budget_exhausted: "today's lending budget used",
  unknown: 'unavailable',
};

const time = (at: number) => new Date(at).toLocaleTimeString();

/** The wait explanation to show for `task`, or null while it is not waiting for an agent. `me` is the viewer's owner name. */
export function waitText(task: Pick<TaskView, 'state' | 'waitReason'>, me?: string | null): WaitText | null {
  if (task.state !== 'QUEUED' && task.state !== 'AWAITING_REVIEWER') return null;
  const w = task.waitReason;
  if (w === null || w === undefined) {
    return { short: 'Waiting for an agent', detail: 'The Leader did not report why this task is waiting.', action: null, tone: 'muted' };
  }
  const text = describe(w, me);
  if (w.role === 'reviewer' && w.nextStep !== 'wait' && w.code !== 'no_author') {
    text.action = `${text.action ?? ''} You can also approve and merge without a review.`.trim();
  }
  return text;
}

export function blockerLabel(b: TaskWaitReason['blockers'][number]): string {
  const label = BLOCKER_LABEL[b.blocker] ?? BLOCKER_LABEL.unknown;
  return b.until !== null ? `${label} until ${time(b.until)}` : label;
}

function describe(w: TaskWaitReason, me: string | null | undefined): WaitText {
  const agent = w.agentId;
  const mine = w.ownerName !== null && w.ownerName === me;
  const role = w.role === 'author' ? 'an author' : 'a reviewer';
  const until = w.until !== null ? ` until ${time(w.until)}` : '';
  switch (w.code) {
    case 'session_starting':
      return { short: `Starting ${agent ?? 'an agent'}`, detail: `${agent ?? 'An agent'} was chosen as ${role} and is opening a session. Work starts when it is ready.`, action: null, tone: 'muted' };
    case 'assigning':
      return { short: `Assigning ${role}`, detail: `An eligible agent is available and will be assigned as ${role} on the next scheduler pass.`, action: null, tone: 'muted' };
    case 'no_agent_online':
      return {
        short: agent !== null ? `${agent} is offline` : w.role === 'reviewer' ? 'No reviewer online' : 'No agent online',
        detail: agent !== null
          ? `Only ${agent} can take this task as ${role}, and it is not connected.`
          : `No agent that can work as ${role} is connected${w.role === 'reviewer' ? ' (the author cannot review its own change)' : ''}.`,
        action: mine ? 'Start your agent from the Dashboard.' : w.ownerName !== null ? `Ask ${w.ownerName} to connect ${agent}.` : 'Ask a teammate to connect their agent.',
        tone: 'warn',
      };
    case 'agents_busy':
      return {
        short: agent !== null ? `${agent} is busy` : 'All agents busy',
        detail: `${agent !== null ? `${agent} is` : 'Every eligible agent is'} using all its session slots. The task starts when a slot frees up.`,
        action: null,
        tone: 'muted',
      };
    case 'review_capacity':
      return { short: 'Waiting for review capacity', detail: 'The Leader is keeping sessions available to review work already in progress. Authoring starts when that capacity frees up.', action: null, tone: 'muted' };
    case 'session_backoff':
      return { short: 'Retrying session start', detail: `Opening a session failed recently. The Leader retries${until || ' shortly'}.`, action: 'If this repeats, check the agent’s logs.', tone: 'warn' };
    case 'rate_limited':
      return { short: `${agent ?? 'Agents'} rate-limited`, detail: `The model provider rate limit applies${until}. The task starts when it clears.`, action: null, tone: 'muted' };
    case 'budget_exhausted':
      return {
        short: 'Lending budget used up',
        detail: `${agent ?? "Teammates' agents"} spent today's lending budget, so ${agent !== null ? 'it' : 'they'} cannot take more work for others.`,
        action: 'Wait for the daily reset, or ask a teammate to raise their lending budget.',
        tone: 'warn',
      };
    case 'not_lending':
      return {
        short: 'No agent lending',
        detail: `${agent ?? "Teammates' agents"} ${agent !== null ? 'does' : 'do'} not lend right now: lend mode is off, or the owner is at the keyboard.`,
        action: 'Ask a teammate to change their lend mode, or wait until they are idle.',
        tone: 'warn',
      };
    case 'agent_paused':
      return {
        short: `${agent ?? 'Agents'} paused`,
        detail: `${agent ?? 'Every remaining agent'} is paused and takes no new work.`,
        action: mine ? 'Resume your agent from the Dashboard.' : w.ownerName !== null ? `Ask ${w.ownerName} to resume ${agent}.` : 'Ask a teammate to resume their agent.',
        tone: 'warn',
      };
    case 'no_author':
      return { short: 'No author on record', detail: 'This task waits for a reviewer but has no author agent.', action: 'Approve and merge it, or cancel it.', tone: 'warn' };
    default:
      return { short: 'Waiting for an agent', detail: 'The Leader reported a reason this app does not recognise.', action: null, tone: 'muted' };
  }
}
