import { afterEach, describe, expect, it } from 'vitest';
import { waitFor, waitForState } from '../helpers/api.js';
import { E2E_READY, Harness } from '../helpers/harness.js';
import { anyTask, approve, authorDone } from '../helpers/mock-script.js';

// Issue #51: a waiting task says why, and the reason follows the agents' real state.

describe.skipIf(!E2E_READY)('wait reasons', () => {
  let h: Harness;
  afterEach(async () => h?.close());

  it('a queued task explains that its agent is offline until the agent connects', async () => {
    h = await Harness.create();
    await h.startLeader();
    const alice = await h.addAgent({ id: 'alice-claude', script: { author: anyTask([authorDone({ 'src/a.js': 'export {};\n' })]) }, config: { lendMode: 'never' } }, { start: false });
    await h.addAgent({ id: 'bob-claude', script: { reviewer: anyTask([approve()]) } });

    const t = await alice.api.createTask({ title: 'Offline author', description: 'x' });
    expect(t.waitReason).toMatchObject({ role: 'author', code: 'no_agent_online', nextStep: 'connect_agent', agentId: 'alice-claude' });
    const listed = (await alice.api.call('listTasks')).tasks.find((x) => x.id === t.id);
    expect(listed?.waitReason).toEqual((await alice.api.getTask(t.id)).task.waitReason);

    await h.startNode('alice-claude');
    const moved = await waitFor('task leaves QUEUED', () => alice.api.getTask(t.id), (d) => d.task.state !== 'QUEUED');
    // Once assigned, the author-side reason is gone (a later reviewer wait has its own reason).
    if (moved.task.state !== 'AWAITING_REVIEWER') expect(moved.task.waitReason).toBeNull();
    await waitForState(alice.api, t.id, 'MERGED');
    expect((await alice.api.getTask(t.id)).task.waitReason).toBeNull();
  });

  it('an awaiting-reviewer task explains that the only reviewer is busy, then clears when capacity frees up', async () => {
    h = await Harness.create();
    await h.startLeader();
    const alice = await h.addAgent({ id: 'alice-claude', script: { author: anyTask([authorDone({ 'src/a.js': 'export {};\n' })]) }, config: { lendMode: 'never' } });
    const carol = await h.addAgent({ id: 'carol-claude', script: { author: anyTask([authorDone({ 'src/c.js': 'export {};\n' })]) }, config: { lendMode: 'never' } });
    await h.addAgent({ id: 'bob-claude', script: { reviewer: anyTask([approve()]), behaviors: { delayMs: 3000 } }, config: { maxSessions: 1 } });

    const t1 = await alice.api.createTask({ title: 'First', description: 'x' });
    await waitForState(alice.api, t1.id, 'IN_REVIEW');
    expect((await alice.api.getTask(t1.id)).task.waitReason).toBeNull();

    const t2 = await carol.api.createTask({ title: 'Second', description: 'x' });
    const waiting = await waitFor('reviewer capacity reason', () => carol.api.getTask(t2.id), (d) => d.task.waitReason?.code === 'agents_busy');
    expect(waiting.task).toMatchObject({ state: 'AWAITING_REVIEWER' });
    expect(waiting.task.waitReason).toMatchObject({ role: 'reviewer', nextStep: 'wait', agentId: 'bob-claude', ownerName: 'bob' });
    // The author (carol) is never a reviewer candidate; alice never lends.
    expect(waiting.task.waitReason!.blockers.map((b) => [b.agentId, b.blocker])).toEqual([
      ['alice-claude', 'not_lending'],
      ['bob-claude', 'busy'],
    ]);

    const reviewing = await waitForState(carol.api, t2.id, 'IN_REVIEW', { timeoutMs: 20_000 });
    expect(reviewing.task.waitReason).toBeNull();
    await waitForState(carol.api, t2.id, 'MERGED');
  });
});
