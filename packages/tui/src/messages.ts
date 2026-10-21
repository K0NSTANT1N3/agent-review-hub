import type { MessageView, TaskEventView } from '@quorum/protocol';

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function quote(value: unknown): string {
  return typeof value === 'string' && value ? `\n${value}` : '';
}

// Plain-text counterpart of desktop TaskDetail.describeMessage. Omit transport plumbing.
export function describeMessage(message: MessageView): string | null {
  const p = record(message.payload);
  const who = message.agentId;
  switch (message.type) {
    case 'author.start': {
      const task = record(p.task);
      return `Leader asked ${who} to write the task${p.continueExisting ? ' (continuing an existing branch)' : ''}${quote(task.description)}`;
    }
    case 'author.revise':
      return `Leader sent ${who} ${Array.isArray(p.openIssues) ? p.openIssues.length : 0} issue(s) to fix${p.testFailure ? ' and a test failure' : ''}`;
    case 'author.sync': return `Leader asked ${who} to merge the latest main`;
    case 'review.start': return `Leader asked ${who} to review (round ${String(p.round)})`;
    case 'review.rereview': return `Leader asked ${who} to re-review the changes (round ${String(p.round)})`;
    case 'author.submitted':
      return p.status === 'blocked' ? `${who} needs a decision${quote(p.blockedReason)}${quote(p.summary)}` : `${who} submitted ${typeof p.headCommit === 'string' ? p.headCommit.slice(0, 7) : ''} — tests ${record(p.tests).passed ? 'passed' : 'failed'}${quote(p.summary)}`;
    case 'review.completed': {
      const output = record(p.output);
      return `${who} reviewed: ${output.verdict === 'approve' ? 'approve' : `changes requested (${Array.isArray(output.newIssues) ? output.newIssues.length : 0} new issue(s))`}${quote(output.summary)}`;
    }
    case 'author.synced': return `${who} merged main ${p.hadConflicts ? 'and resolved conflicts' : 'cleanly'}`;
    case 'turn.failed': return p.code === 'CANCELLED' ? `${who} stopped its current turn (cancelled)` : `${who} turn failed: ${String(p.code)} — ${String(p.message)}`;
    case 'session.compacted': return `${who} compacted its session to free context`;
    case 'author.answer': return `Leader relayed the human answer to ${who}${quote(p.answer)}`;
    default: return null;
  }
}

export function describeTaskEvent(event: TaskEventView): string {
  const details = ['comment', 'answer', 'reason'].map((key) => event.data[key]).filter((value): value is string => typeof value === 'string' && value.length > 0);
  return `${event.reason.replaceAll('_', ' ')} · ${event.toState}${details.length ? `\n${details.join('\n')}` : ''}`;
}
