import { describe, expect, it } from 'vitest';
import { describeMessage, describeTaskEvent } from '../src/messages.js';
import { message, taskEvent } from './fixtures.js';

describe('Leader messages', () => {
  it.each([
    ['author.start', { continueExisting: true }, 'continuing an existing branch'],
    ['author.revise', { openIssues: [1, 2], testFailure: 'failed' }, '2 issue(s) to fix and a test failure'],
    ['author.sync', {}, 'merge the latest main'],
    ['review.start', { round: 1 }, 'review (round 1)'],
    ['review.rereview', { round: 2 }, 're-review the changes (round 2)'],
    ['author.submitted', { headCommit: 'abcdef01234', tests: { passed: false }, summary: 'Done' }, 'submitted abcdef0 — tests failed\nDone'],
    ['author.submitted', { status: 'blocked', blockedReason: 'Which DB?', summary: 'Waiting' }, 'needs a decision\nWhich DB?\nWaiting'],
    ['review.completed', { output: { verdict: 'approve', summary: 'Looks good' } }, 'reviewed: approve\nLooks good'],
    ['review.completed', { output: { verdict: 'request_changes', newIssues: [1] } }, 'changes requested (1 new issue(s))'],
    ['author.synced', { hadConflicts: true }, 'and resolved conflicts'],
    ['author.synced', { hadConflicts: false }, 'cleanly'],
    ['turn.failed', { code: 'CANCELLED' }, 'stopped its current turn (cancelled)'],
    ['turn.failed', { code: 'TIMEOUT', message: 'Too slow' }, 'turn failed: TIMEOUT — Too slow'],
    ['session.compacted', {}, 'compacted its session to free context'],
  ])('describes %s with desktop-compatible wording', (type, payload, expected) => {
    expect(describeMessage(message({ type, payload }))).toContain(expected);
  });

  it('omits plumbing and safely handles malformed payloads', () => {
    expect(describeMessage(message({ type: 'session.open', payload: null }))).toBeNull();
    expect(describeMessage(message({ type: 'review.completed', payload: null }))).toContain('0 new issue(s)');
  });

  it('describes durable human actions with their comment', () => {
    expect(describeTaskEvent(taskEvent({ reason: 'sent_back_by_human', actor: 'human:tazo', data: { comment: 'Fix TTL' } }))).toBe('sent back by human · IN_REVIEW\nFix TTL');
  });
});
