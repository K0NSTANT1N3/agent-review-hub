import { afterEach, describe, expect, it } from 'vitest';
import { stateHistory, waitForState } from '../helpers/api.js';
import { E2E_READY, Harness, aliceAndBob } from '../helpers/harness.js';
import { anyTask, approve, authorDone, authorRevised, requestChanges } from '../helpers/mock-script.js';
import { GREET, mainLog, readMain, remoteBranches } from '../helpers/toy-project.js';

// Spec §21.2 scenarios 1–4.

describe.skipIf(!E2E_READY)('review flow', () => {
  let h: Harness;
  afterEach(async () => h?.close());

  it('#1 happy path: author → review → approve → merged with trailers, locks released, branch deleted', async () => {
    h = await Harness.create();
    const { alice } = await aliceAndBob(h, {
      alice: { author: anyTask([authorDone({ 'src/greet.js': GREET.withDefault })]) },
      bob: { reviewer: anyTask([approve()]) },
    });

    const task = await alice.api.createTask({ title: 'Add default name', description: 'greet() with no args says Hello world' });
    expect(task.state).toBe('QUEUED');
    const done = await waitForState(alice.api, task.id, 'MERGED');

    expect(stateHistory(done)).toEqual(['QUEUED', 'AUTHORING', 'AWAITING_REVIEWER', 'IN_REVIEW', 'MERGE_QUEUED', 'MERGING', 'MERGED']);
    expect(await readMain(h.bare, 'src/greet.js')).toBe(GREET.withDefault);

    const [head] = await mainLog(h.bare);
    expect(head?.message).toContain(`Quorum-Task: ${task.id}`);
    expect(head?.message).toContain('Quorum-Author: alice-claude');
    expect(head?.message).toContain('Quorum-Reviewer: bob-claude');
    expect(done.task.mergedCommit).toBe(head?.sha);

    expect(done.conversations).toHaveLength(1);
    expect(done.conversations[0]).toMatchObject({ authorAgentId: 'alice-claude', reviewerAgentId: 'bob-claude', state: 'closed' });
    const { sessions } = await alice.api.call('listSessions');
    expect(sessions.filter((s) => s.state === 'locked')).toEqual([]);
    expect(await remoteBranches(h.bare)).toEqual(['main']);
  });

  it('#2 two rounds: same conversation and reviewer session; re-review sees only the delta', async () => {
    h = await Harness.create();
    const { alice } = await aliceAndBob(h, {
      alice: {
        author: anyTask([
          authorDone({ 'src/greet.js': GREET.variantA }),
          authorRevised({ 'src/greet.js': GREET.withDefault }, [{ issue: 'I1', action: 'fixed', note: 'added default' }]),
        ]),
      },
      bob: { reviewer: anyTask([requestChanges('needs a default name'), approve([{ issue: 'I1', status: 'resolved' }])]) },
    });

    const task = await alice.api.createTask({ title: 'Two rounds', description: 'x' });
    const done = await waitForState(alice.api, task.id, 'MERGED');

    expect(done.conversations).toHaveLength(1);
    const conv = done.conversations[0]!;
    expect(done.issues).toEqual([expect.objectContaining({ code: 'I1', severity: 'blocking', status: 'resolved', authorResponse: 'fixed' })]);

    const toReviewer = done.messages.filter((m) => m.direction === 'to_node' && m.agentId === 'bob-claude' && m.type.startsWith('review.'));
    expect(toReviewer.map((m) => m.type)).toEqual(['review.start', 'review.rereview']);
    expect(new Set(toReviewer.map((m) => m.sessionId))).toEqual(new Set([conv.reviewerSessionId]));
    expect(toReviewer.every((m) => m.conversationId === conv.id)).toBe(true);
    const start = toReviewer[0]!.payload as { headCommit: string };
    const rereview = toReviewer[1]!.payload as { fromCommit: string; headCommit: string; reason: string };
    expect(rereview.fromCommit).toBe(start.headCommit);
    expect(rereview.headCommit).not.toBe(start.headCommit);
    expect(rereview.reason).toBe('revision');

    // Only Leader→Node commands carry a per-conversation seq; it must strictly increase.
    const seqs = done.messages.filter((m) => m.conversationId === conv.id && m.direction === 'to_node').map((m) => m.seq ?? -1);
    expect(seqs.length).toBeGreaterThan(1);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('#3 round limit escalates; human approval then merges', async () => {
    h = await Harness.create({ limits: { maxReviewRounds: 2 } });
    // Each revision answers exactly the open blocking issue; each re-review resolves it and raises a new one.
    const revise = (n: number) =>
      authorRevised({ 'src/greet.js': `export const greet = (name) => \`Hello \${name}\`; // r${n}\n` }, [{ issue: `I${n}`, action: 'fixed' }]);
    const { alice } = await aliceAndBob(h, {
      alice: { author: anyTask([authorDone({ 'src/greet.js': GREET.variantA }), revise(1), revise(2), revise(3)]) },
      bob: {
        reviewer: anyTask([
          requestChanges('one'),
          requestChanges('two', [{ issue: 'I1', status: 'resolved' }]),
          requestChanges('three', [{ issue: 'I2', status: 'resolved' }]),
        ]),
      },
    });
    const task = await alice.api.createTask({ title: 'Never good enough', description: 'x' });

    const escalated = await waitForState(alice.api, task.id, 'ESCALATED');
    expect(escalated.task.escalationReason).toMatch(/round_limit|dispute_limit/);

    await alice.api.approve(task.id);
    await waitForState(alice.api, task.id, 'MERGED');
  });

  it('#4 dispute limit: author disputes I1 twice, reviewer keeps it open → ESCALATED', async () => {
    h = await Harness.create({ limits: { maxReviewRounds: 10, maxDisputesPerIssue: 2 } });
    const dispute = authorRevised({}, [{ issue: 'I1', action: 'disputed', note: 'disagree' }]);
    const { alice } = await aliceAndBob(h, {
      alice: { author: anyTask([authorDone({ 'src/greet.js': GREET.variantA }), dispute, dispute, dispute]) },
      bob: {
        reviewer: anyTask([
          requestChanges('rename it'),
          approve([{ issue: 'I1', status: 'still_open' }]),
          approve([{ issue: 'I1', status: 'still_open' }]),
          approve([{ issue: 'I1', status: 'still_open' }]),
        ]),
      },
    });

    const task = await alice.api.createTask({ title: 'Disputed', description: 'x' });
    const escalated = await waitForState(alice.api, task.id, 'ESCALATED');
    expect(escalated.task.escalationReason).toBe('dispute_limit');
    // The reviewer's stated "approve" is not trusted while I1 stays open (spec §8.3).
    expect(stateHistory(escalated)).not.toContain('MERGE_QUEUED');
    expect(escalated.issues.find((i) => i.code === 'I1')).toMatchObject({ status: 'open', disputeCount: 2 });
  });
});
