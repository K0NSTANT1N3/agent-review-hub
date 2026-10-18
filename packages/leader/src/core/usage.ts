import type { CmdFrame, Event } from '@quorum/protocol';
import type { LeaderDb } from '../db/repo.js';

export function recordTurnUsage(db: LeaderDb, agentId: string, event: Event, at: number, emaAlpha: number): void {
  if (!('usage' in event) || event.usage === undefined) return;
  const usage = event.usage;
  const agent = db.agents.require(agentId);
  const reply = 'inReplyTo' in event ? db.messages.get(event.inReplyTo) : undefined;
  const command = reply?.direction === 'to_node' && reply.agent_id === agentId && reply.session_id === event.sid
    ? (JSON.parse(reply.payload) as CmdFrame).cmd : undefined;
  const estimated = command !== undefined && 'estimated' in command ? command.estimated : null;
  const taskId = 'taskId' in event ? event.taskId ?? null : null;
  const directiveId = 'directiveId' in event ? event.directiveId ?? null : null;
  const task = taskId === null ? undefined : db.tasks.get(taskId);
  const requester = task !== undefined ? db.agents.require(task.requester_agent_id).owner_name
    : directiveId !== null ? db.directives.get(directiveId)?.requester : agent.owner_name;
  const role = command?.type.startsWith('author.') || event.type.startsWith('author.') ? 'author'
    : command?.type.startsWith('review.') || event.type.startsWith('review.') ? 'reviewer'
      : directiveId !== null ? 'directive' : 'maintenance';
  db.usageLedger.insert({
    agent_id: agentId, session_id: event.sid, task_id: taskId, directive_id: directiveId,
    kind: requester === agent.owner_name ? 'own' : 'lent', role,
    input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, estimated, at,
  });
  const session = db.sessions.get(event.sid);
  if (session?.agent_id === agentId) db.sessions.update(session.id, { context_tokens: usage.contextTokens });
  if (estimated !== null && estimated > 0) {
    const ratio = (usage.inputTokens + usage.outputTokens) / estimated;
    db.agents.update(agentId, { cost_ratio_ema: Math.max(0.25, Math.min(4, (1 - emaAlpha) * agent.cost_ratio_ema + emaAlpha * ratio)) });
  }
}
