import { addAgent } from '@quorum/leader';
import { afterEach, describe, expect, it } from 'vitest';
import { Api, waitFor, waitForState } from '../helpers/api.js';
import { E2E_READY, Harness, aliceAndBob } from '../helpers/harness.js';
import { anyTask, approve, authorBlocked, authorDone, authorRevised, directiveAnswer } from '../helpers/mock-script.js';
import { GREET } from '../helpers/toy-project.js';

// Requester-scope API tokens (the quorum CLI): read, create, answer and ask; never approve or merge.

describe.skipIf(!E2E_READY)('requester API tokens', () => {
  let h: Harness;
  afterEach(async () => h?.close());

  it('#22 a requester token creates and follows tasks, answers a blocked author and asks agents', async () => {
    h = await Harness.create();
    const { alice } = await aliceAndBob(h, {
      alice: {
        author: anyTask([
          authorBlocked('Should greet() default to "world" or throw?'),
          authorRevised({ 'src/greet.js': GREET.withDefault }, [{ issue: 'I1', action: 'fixed', note: 'used world' }]),
        ]),
      },
      bob: { reviewer: anyTask([approve([{ issue: 'I1', status: 'resolved' }])]), directive: anyTask([directiveAnswer('42')]) },
    });
    const minted = await alice.api.call('createApiToken', { body: { label: 'claude code' } });
    expect(minted).toMatchObject({ agentId: 'alice-claude', scope: 'requester', label: 'claude code', revokedAt: null });
    expect(minted.token).toMatch(/^qrq_/);
    const cli = new Api(h.httpUrl, minted.token);

    const task = await cli.createTask({ title: 'Via CLI', description: 'x' });
    expect(task.requesterOwner).toBe('alice');
    const esc = await waitForState(cli, task.id, 'ESCALATED');
    expect(esc.task.escalationReason).toContain('author_blocked');

    // Human-only actions are refused for the token, whatever the task state.
    for (const route of ['approveTask', 'sendBackTask', 'cancelTask', 'pauseTask', 'reassignReviewer'] as const) {
      const res = await cli.status(route, { id: task.id, body: route === 'sendBackTask' ? { comment: 'x' } : {} });
      expect(res.status, route).toBe(403);
    }
    expect((await cli.status('createApiToken', { body: {} })).status).toBe(403);
    expect((await cli.status('listApiTokens')).status).toBe(403);

    await cli.call('answerTask', { id: task.id, body: { answer: 'Default to "world".' } });
    const done = await waitForState(cli, task.id, 'MERGED');
    expect(done.events.some((e) => e.reason === 'sent_back_by_human' && e.actor === 'token:alice')).toBe(true);
    expect((await cli.call('getTaskDiff', { id: task.id })).diff).toContain('world');

    // Answering is only valid while an author is blocked.
    expect((await cli.status('answerTask', { id: task.id, body: { answer: 'again' } })).status).toBe(409);

    const d = await cli.createDirective({ agentId: 'bob-claude', text: 'What is the answer?' });
    const answered = await waitFor('directive done', () => cli.getDirective(d.id), (x) => x.state === 'done' || x.state === 'failed');
    expect(answered).toMatchObject({ state: 'done', resultText: '42', requester: 'alice' });

    const listed = await alice.api.call('listApiTokens');
    expect(listed.tokens).toHaveLength(1);
    expect(listed.tokens[0]!.lastUsedAt).not.toBeNull();
    expect(JSON.stringify(listed)).not.toContain(minted.token);
  });

  it('#23 revoking a token, or rotating its agent token, cuts it off', async () => {
    h = await Harness.create();
    const { alice, bob } = await aliceAndBob(h, {
      alice: { author: anyTask([authorDone({ 'src/greet.js': GREET.withDefault })]) },
      bob: { reviewer: anyTask([approve()]) },
    });
    const first = await alice.api.call('createApiToken', { body: {} });
    const firstCli = new Api(h.httpUrl, first.token);
    expect((await firstCli.status('listAgents')).status).toBe(200);

    // Another owner cannot revoke it.
    expect((await bob.api.status('revokeApiToken', { id: first.id })).status).toBe(404);
    const revoked = await alice.api.call('revokeApiToken', { id: first.id });
    expect(revoked.revokedAt).not.toBeNull();
    expect((await firstCli.status('listAgents')).status).toBe(401);

    const second = await alice.api.call('createApiToken', { body: {} });
    const secondCli = new Api(h.httpUrl, second.token);
    expect((await secondCli.status('listAgents')).status).toBe(200);
    // Re-inviting alice rotates her agent token and revokes the API tokens minted with the old one.
    await addAgent(h.leaderConfig.dbPath, { id: 'alice-claude', owner: 'alice' });
    expect((await secondCli.status('listAgents')).status).toBe(401);
  });
});
