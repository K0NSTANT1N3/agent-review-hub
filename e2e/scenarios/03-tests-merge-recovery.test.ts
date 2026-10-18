import { afterEach, describe, expect, it } from 'vitest';
import { stateHistory, waitForState } from '../helpers/api.js';
import { E2E_READY, Harness, aliceAndBob } from '../helpers/harness.js';
import { anyTask, approve, authorDone, authorRevised, syncResolved } from '../helpers/mock-script.js';
import { GREET, readMain } from '../helpers/toy-project.js';

// Spec §21.2 scenarios 12–17.

describe.skipIf(!E2E_READY)('tests, merging and recovery', () => {
  let h: Harness;
  afterEach(async () => h?.close());

  it('#12 failing tests return to the author with a system issue; the fix proceeds to review', async () => {
    h = await Harness.create();
    const { alice } = await aliceAndBob(h, {
      alice: {
        author: anyTask([
          authorDone({ 'src/greet.js': GREET.BROKEN }),
          // The system issue for the test failure is the only open blocking issue: I1.
          authorRevised({ 'src/greet.js': GREET.withDefault }, [{ issue: 'I1', action: 'fixed' }]),
        ]),
      },
      // System issues auto-resolve once tests pass, so the reviewer never sees I1.
      bob: { reviewer: anyTask([approve()]) },
    });
    const task = await alice.api.createTask({ title: 'Breaks tests first', description: 'x' });
    const done = await waitForState(alice.api, task.id, 'MERGED');

    expect(done.issues.find((i) => i.source === 'system')).toMatchObject({ severity: 'blocking', status: 'resolved' });
    const revise = done.messages.find((m) => m.type === 'author.revise');
    expect((revise?.payload as { testFailure: string | null }).testFailure).toMatch(/expected "Hello x"/);
    expect(await readMain(h.bare, 'src/greet.js')).toBe(GREET.withDefault);
  });

  it('#12b exhausting test-fix attempts escalates', async () => {
    h = await Harness.create({ limits: { maxTestFixAttempts: 1 } });
    const { alice } = await aliceAndBob(h, {
      alice: {
        author: anyTask([
          authorDone({ 'src/greet.js': GREET.BROKEN }),
          authorRevised({ 'src/greet.js': GREET.BROKEN + '// still\n' }, [{ issue: 'I1', action: 'fixed' }]),
        ]),
      },
      bob: { reviewer: anyTask([approve()]) },
    });
    const task = await alice.api.createTask({ title: 'Always broken', description: 'x' });
    const esc = await waitForState(alice.api, task.id, 'ESCALATED');
    expect(esc.task.escalationReason).toBe('tests_failing');
  });

  it('#13 merge conflict → SYNCING → author resolves → re-review (sync_conflicts) → merged', async () => {
    h = await Harness.create();
    await h.startLeader();
    // Both authors change the same line; whichever merges second must sync.
    const alice = await h.addAgent({
      id: 'alice-claude',
      script: { author: anyTask([authorDone({ 'src/greet.js': GREET.variantA }), syncResolved({ 'src/greet.js': GREET.resolved })]) },
      config: { lendMode: 'never' },
    });
    const carol = await h.addAgent({
      id: 'carol-claude',
      script: { author: anyTask([authorDone({ 'src/greet.js': GREET.variantB }), syncResolved({ 'src/greet.js': GREET.resolved })]) },
      config: { lendMode: 'never' },
    });
    await h.addAgent({ id: 'bob-claude', script: { reviewer: anyTask([approve(), approve()]) }, config: { maxSessions: 2 } });

    const t1 = await alice.api.createTask({ title: 'Variant A', description: 'x' });
    const t2 = await carol.api.createTask({ title: 'Variant B', description: 'x' });
    const [d1, d2] = await Promise.all([
      waitForState(alice.api, t1.id, 'MERGED', { timeoutMs: 60_000 }),
      waitForState(carol.api, t2.id, 'MERGED', { timeoutMs: 60_000 }),
    ]);

    const synced = [d1, d2].filter((d) => stateHistory(d).includes('SYNCING'));
    expect(synced).toHaveLength(1);
    const rereview = synced[0]!.messages.find((m) => m.type === 'review.rereview');
    expect((rereview?.payload as { reason: string }).reason).toBe('sync_conflicts');
    expect(await readMain(h.bare, 'src/greet.js')).toBe(GREET.resolved);
  });

  it('#14 clean sync: main moved without conflicts → straight back to MERGE_QUEUED, no re-review', async () => {
    h = await Harness.create();
    await h.startLeader();
    const alice = await h.addAgent({ id: 'alice-claude', script: { author: anyTask([authorDone({ 'src/a.js': 'export const a = 1;\n' })]) }, config: { lendMode: 'never' } });
    const carol = await h.addAgent({ id: 'carol-claude', script: { author: anyTask([authorDone({ 'src/b.js': 'export const b = 2;\n' })]) }, config: { lendMode: 'never' } });
    await h.addAgent({ id: 'bob-claude', script: { reviewer: anyTask([approve()]) } });

    const t1 = await alice.api.createTask({ title: 'Adds a', description: 'x' });
    const t2 = await carol.api.createTask({ title: 'Adds b', description: 'x' });
    const [d1, d2] = await Promise.all([waitForState(alice.api, t1.id, 'MERGED'), waitForState(carol.api, t2.id, 'MERGED')]);

    // A squash merge of disjoint files never conflicts, so no SYNCING and no re-review is needed.
    for (const d of [d1, d2]) {
      expect(d.messages.filter((m) => m.type === 'review.rereview')).toEqual([]);
    }
    expect(await readMain(h.bare, 'src/a.js')).not.toBeNull();
    expect(await readMain(h.bare, 'src/b.js')).not.toBeNull();
  });

  it('#15 leader restart during review: nodes reconnect, the result is applied once, flow completes', async () => {
    h = await Harness.create();
    const { alice } = await aliceAndBob(h, {
      alice: { author: anyTask([authorDone({ 'src/greet.js': GREET.withDefault })]) },
      bob: { reviewer: anyTask([approve()]), behaviors: { delayMs: 3000 } },
    });
    const task = await alice.api.createTask({ title: 'Survives restart', description: 'x' });
    await waitForState(alice.api, task.id, 'IN_REVIEW');

    await h.restartLeader(1000);
    const done = await waitForState(alice.api, task.id, 'MERGED', { timeoutMs: 45_000 });

    const completed = done.messages.filter((m) => m.direction === 'from_node' && m.type === 'review.completed');
    expect(completed).toHaveLength(1);
    expect(done.events.filter((e) => e.toState === 'MERGE_QUEUED')).toHaveLength(1);
  });

  // #16 (duplicated review.completed frame applied once) needs raw frame injection; it is covered by
  // Leader L4 tests with test/helpers/fake-node.ts. #15 above exercises redelivery end to end.
  it.todo('#16 duplicate delivery — covered by packages/leader L4 fake-node tests');

  it('#17 invalid output twice then valid → succeeds', async () => {
    h = await Harness.create();
    const { alice } = await aliceAndBob(h, {
      alice: { author: anyTask([authorDone({ 'src/greet.js': GREET.withDefault })]) },
      bob: { reviewer: anyTask([{ rawReply: 'no block here' }, { rawReply: '```quorum-json\n{"verdict":1}\n```' }, approve()]) },
    });
    const task = await alice.api.createTask({ title: 'Sloppy reviewer', description: 'x' });
    const done = await waitForState(alice.api, task.id, 'MERGED');
    expect(done.conversations).toHaveLength(1);
  });

  it('#17b always-invalid output → turn.failed INVALID_OUTPUT → reviewer reassigned', async () => {
    h = await Harness.create({ limits: { maxTurnRetries: 0 } });
    const junk = { rawReply: 'still no block' };
    const { alice } = await aliceAndBob(h, {
      alice: { author: anyTask([authorDone({ 'src/greet.js': GREET.withDefault })]) },
      // Keep the first review open long enough for Carol to join after the test observes IN_REVIEW.
      bob: { reviewer: anyTask([junk, junk, junk, junk, junk, junk]), behaviors: { delayMs: 1500 } },
    });
    const task = await alice.api.createTask({ title: 'Broken reviewer', description: 'x' });
    await waitForState(alice.api, task.id, 'IN_REVIEW');
    await h.addAgent({ id: 'carol-claude', script: { reviewer: anyTask([approve()]) } });
    const done = await waitForState(alice.api, task.id, 'MERGED', { timeoutMs: 45_000 });
    expect(done.messages.some((m) => m.type === 'turn.failed' && (m.payload as { code: string }).code === 'INVALID_OUTPUT')).toBe(true);
    expect(done.conversations.at(-1)?.reviewerAgentId).toBe('carol-claude');
  });
});
