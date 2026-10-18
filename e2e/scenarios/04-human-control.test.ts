import { afterEach, describe, expect, it } from 'vitest';
import { waitFor, waitForState } from '../helpers/api.js';
import { E2E_READY, Harness, aliceAndBob } from '../helpers/harness.js';
import { anyTask, approve, authorBlocked, authorDone, authorRevised, directiveAnswer, requestChanges } from '../helpers/mock-script.js';
import { GREET, remoteBranches } from '../helpers/toy-project.js';

// Spec §21.2 scenarios 18–21.

describe.skipIf(!E2E_READY)('human control, directives, compaction', () => {
  let h: Harness;
  afterEach(async () => h?.close());

  it('#18 directive to a locked session is 409 SESSION_LOCKED; without sessionId it runs and stores the answer', async () => {
    h = await Harness.create();
    const { alice } = await aliceAndBob(h, {
      alice: { author: anyTask([authorDone({ 'src/greet.js': GREET.withDefault })]) },
      bob: { reviewer: anyTask([approve()]), directive: anyTask([directiveAnswer('42')]), behaviors: { delayMs: 3000 } },
    });
    const task = await alice.api.createTask({ title: 'Busy reviewer', description: 'x' });
    const inReview = await waitForState(alice.api, task.id, 'IN_REVIEW');
    const lockedSid = inReview.conversations[0]!.reviewerSessionId;

    const res = await alice.api.status('createDirective', { body: { agentId: 'bob-claude', text: 'hi', sessionId: lockedSid } });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'SESSION_LOCKED' });

    const d = await alice.api.createDirective({ agentId: 'bob-claude', text: 'What is the answer?' });
    const finished = await waitFor('directive done', () => alice.api.getDirective(d.id), (x) => x.state === 'done' || x.state === 'failed');
    expect(finished).toMatchObject({ state: 'done', resultText: '42' });
    expect(finished.sessionId).not.toBe(lockedSid);
  });

  it('#19 cancel during AUTHORING aborts the turn, releases locks and deletes the branch', async () => {
    h = await Harness.create();
    const { alice } = await aliceAndBob(h, {
      alice: { author: anyTask([authorDone({ 'src/greet.js': GREET.withDefault })]), behaviors: { delayMs: 30_000 } },
      bob: { reviewer: anyTask([approve()]) },
    });
    const task = await alice.api.createTask({ title: 'Cancel me', description: 'x' });
    await waitForState(alice.api, task.id, 'AUTHORING');
    await alice.api.cancel(task.id);
    await waitForState(alice.api, task.id, 'CANCELLED');

    await waitFor('locks released', () => alice.api.call('listSessions'), (r) => r.sessions.every((s) => s.state !== 'locked'));
    await waitFor('branch deleted', () => remoteBranches(h.bare), (b) => b.length === 1 && b[0] === 'main');
  });

  it('#19b only the requester or an admin may cancel', async () => {
    h = await Harness.create();
    const { alice, bob } = await aliceAndBob(h, {
      alice: { author: anyTask([authorDone({ 'src/greet.js': GREET.withDefault })]), behaviors: { delayMs: 30_000 } },
      bob: { reviewer: anyTask([approve()]) },
    });
    const task = await alice.api.createTask({ title: 'Not yours', description: 'x' });
    expect((await bob.api.status('cancelTask', { id: task.id })).status).toBe(403);
    const admin = await h.adminApi();
    await admin.cancel(task.id);
    await waitForState(alice.api, task.id, 'CANCELLED');
  });

  it('#20 context compaction keeps the same sid and the flow completes', async () => {
    h = await Harness.create();
    await h.startLeader();
    // Tiny window: after the first turn the author session is over contextPressurePct, so the
    // next command (author.revise) compacts first. The mock answers the summarize/seed turns itself.
    const alice = await h.addAgent({
      id: 'alice-claude',
      contextWindow: 4000,
      config: { lendMode: 'never' },
      script: {
        author: anyTask([
          authorDone({ 'src/greet.js': GREET.variantA }),
          authorRevised({ 'src/greet.js': GREET.withDefault }, [{ issue: 'I1', action: 'fixed' }]),
        ]),
        behaviors: { tokensPerTurn: { input: 5000, output: 100 } },
      },
    });
    await h.addAgent({
      id: 'bob-claude',
      script: { reviewer: anyTask([requestChanges('default please'), approve([{ issue: 'I1', status: 'resolved' }])]) },
    });
    const task = await alice.api.createTask({ title: 'Compaction', description: 'x' });
    const done = await waitForState(alice.api, task.id, 'MERGED');
    expect(done.messages.some((m) => m.direction === 'from_node' && m.type === 'session.compacted')).toBe(true);
    const authorSids = new Set(done.messages.filter((m) => m.type.startsWith('author.') && m.direction === 'to_node').map((m) => m.sessionId));
    expect(authorSids.size).toBe(1);
  });

  it('#21 blocked author → ESCALATED with the question → human answers via send-back → continues', async () => {
    h = await Harness.create();
    const { alice } = await aliceAndBob(h, {
      alice: {
        author: anyTask([
          authorBlocked('Should greet() default to "world" or throw?'),
          authorRevised({ 'src/greet.js': GREET.withDefault }, [{ issue: 'I1', action: 'fixed', note: 'used world' }]),
        ]),
      },
      bob: { reviewer: anyTask([approve([{ issue: 'I1', status: 'resolved' }])]) },
    });
    const task = await alice.api.createTask({ title: 'Needs a decision', description: 'x' });
    const esc = await waitForState(alice.api, task.id, 'ESCALATED');
    expect(esc.task.escalationReason).toContain('author_blocked');
    expect(esc.task.escalationReason).toContain('default to "world"');

    await alice.api.sendBack(task.id, 'Default to "world".');
    const done = await waitForState(alice.api, task.id, 'MERGED');
    expect(done.issues.find((i) => i.source === 'human')).toMatchObject({ code: 'I1', status: 'resolved' });
  });
});
