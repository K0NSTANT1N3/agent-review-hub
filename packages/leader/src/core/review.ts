import { ReviewOutputSchema, type ReviewOutput } from '@quorum/protocol';
import type { IssueRow, LeaderDb, TaskRow } from '../db/repo.js';

/** Codes are monotonically allocated across the entire task's issue history. */
export function nextIssueCode(db: LeaderDb, taskId: number): string {
  let maximum = 0n;
  for (const issue of db.issues.find({ task_id: taskId })) {
    if (!/^I[1-9][0-9]*$/.test(issue.code)) continue;
    const value = BigInt(issue.code.slice(1));
    if (value > maximum) maximum = value;
  }
  return `I${maximum + 1n}`;
}

export interface AppliedReview {
  verdict: 'approve' | 'changes';
  openBlocking: IssueRow[];
}

/** Apply §8.3 bookkeeping; a model's stated verdict never overrides open blockers. */
export function applyReview(
  db: LeaderDb,
  task: TaskRow,
  conversationId: string,
  output: ReviewOutput,
  at: number,
): AppliedReview {
  const parsed = ReviewOutputSchema.parse(output);
  if (!Number.isSafeInteger(at) || at < 0) throw new TypeError('Review timestamp must be a non-negative integer');
  return db.withTx(() => {
    const conversation = db.conversations.require(conversationId);
    if (conversation.task_id !== task.id) throw new Error('Review conversation belongs to another task');
    const issues = new Map(db.issues.find({ task_id: task.id }).map((issue) => [issue.code, issue]));
    const handled = new Set<string>();
    for (const previous of parsed.previousIssues) {
      // Node coverage validation rejects duplicates. Defend here as well so a
      // duplicate cannot inflate dispute_count within an accepted review.
      if (handled.has(previous.issue)) continue;
      handled.add(previous.issue);
      const issue = issues.get(previous.issue);
      if (issue === undefined) continue;
      if (previous.status === 'resolved') db.issues.update(issue.id, { status: 'resolved' });
      else if (issue.author_response === 'disputed' || issue.author_response === 'wontfix') {
        db.issues.update(issue.id, { dispute_count: issue.dispute_count + 1 });
      }
    }
    let next = BigInt(nextIssueCode(db, task.id).slice(1));
    for (const issue of parsed.newIssues) {
      db.issues.insert({
        task_id: task.id,
        code: `I${next++}`,
        source: 'reviewer',
        severity: issue.severity,
        file: issue.file,
        line: issue.line,
        comment: issue.comment,
        status: 'open',
        raised_round: task.review_round,
        conversation_id: conversationId,
        created_at: at,
      });
    }
    const openBlocking = db.issues.find({ task_id: task.id, status: 'open', severity: 'blocking' });
    return { verdict: openBlocking.length === 0 ? 'approve' : 'changes', openBlocking };
  });
}
