import type { UiEvent } from '@quorum/protocol';
import type { AppState } from '../shared/ipc.js';

// No Electron imports so it is testable with plain Node; main.ts supplies `show`.

export interface NotifierDeps {
  show(title: string, body: string): void;
  /** Looks up the requester of a task this notifier has not seen in a task.updated event yet. */
  requesterOf(taskId: number): Promise<string | null>;
}

/** OS notifications for the user's own tasks: merged, escalated, or needing attention. */
export function createNotifier(deps: NotifierDeps): (event: UiEvent, state: AppState) => void {
  const lastState = new Map<number, string>();
  const requester = new Map<number, string>();
  // An escalation emits both task.needs_attention and task.updated ESCALATED, in either order: notify once.
  const escalated = new Set<number>();
  let lastRateLimit: number | null = null;

  const notifyEscalation = (taskId: number, title: string, body: string): void => {
    if (escalated.has(taskId)) return;
    escalated.add(taskId);
    deps.show(title, body);
  };

  return (event, state) => {
    if (event.type === 'task.updated') {
      const t = event.data;
      requester.set(t.id, t.requesterOwner);
      if (t.state !== 'ESCALATED') escalated.delete(t.id);
      const prev = lastState.get(t.id);
      lastState.set(t.id, t.state);
      if (prev === undefined || prev === t.state || t.requesterOwner !== state.ownerName) return;
      if (t.state === 'MERGED') deps.show('Merged ✓', `#${t.id} ${t.title}`);
      if (t.state === 'ESCALATED') notifyEscalation(t.id, 'Needs your decision', `#${t.id} ${t.title}: ${t.escalationReason ?? ''}`);
    } else if (event.type === 'task.needs_attention') {
      const { taskId, reason, message } = event.data;
      const owner = state.ownerName;
      const notify = (): void => {
        const title = `Task #${taskId} needs attention`;
        if (reason === 'escalated') notifyEscalation(taskId, title, message);
        else deps.show(title, message);
      };
      const known = requester.get(taskId);
      if (known !== undefined) {
        if (known === owner) notify();
        return;
      }
      void deps
        .requesterOf(taskId)
        .then((who) => {
          if (who === null) return;
          requester.set(taskId, who);
          if (who === owner) notify();
        })
        .catch(() => undefined);
    } else if (event.type === 'agent.updated' && event.data.id === state.agentId) {
      // agent.updated fires on every heartbeat; notify once per new limit.
      const limit = event.data.rateLimitedUntil;
      if (limit === lastRateLimit) return;
      lastRateLimit = limit;
      if (limit === null) return;
      const until = new Date(limit).toLocaleTimeString();
      deps.show('Your agent is rate-limited', `Usage resets around ${until}.`);
    }
  };
}
