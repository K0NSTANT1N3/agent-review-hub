import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_ROUTES, parseLeaderConfig, type AgentEvent, type ApiRouteName } from '@quorum/protocol';
import { registerRoutes } from '../../src/api/routes.js';
import { mintApiToken, resolvePrincipal } from '../../src/core/api-tokens.js';
import { EventHandlers } from '../../src/core/handlers.js';
import { LockManager } from '../../src/core/locks.js';
import { MergeWorker } from '../../src/core/merge-worker.js';
import { Scheduler } from '../../src/core/scheduler.js';
import { openDatabase, type LeaderDb } from '../../src/db/repo.js';
import { LeaderGit } from '../../src/git/leader-git.js';
import { createHash } from 'node:crypto';

let db: LeaderDb;
let server: FastifyInstance;
let tokens: Record<string, string>;

const event: AgentEvent = { seq: 1, at: 1, kind: 'text', mode: 'final', text: 'done' };
const task = (owner = 'alice', state = 'QUEUED') => db.tasks.insert({
  title: 'Task', description: 'd', requester_agent_id: owner, author_agent_id: owner, state,
  head_commit: 'a'.repeat(40), created_at: 1, updated_at: 1, state_entered_at: 1,
});
const request = (method: 'GET' | 'POST' | 'PATCH', url: string, token?: string, payload?: object) => server.inject({
  method, url, headers: token === undefined ? {} : { authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload }),
});

beforeEach(() => {
  db = openDatabase(':memory:');
  server = Fastify();
  tokens = {};
  for (const id of ['alice', 'alice-other', 'bob', 'admin']) {
    tokens[id] = `qrm_${id}`;
    db.agents.insert({ id, owner_name: id === 'alice-other' ? 'alice' : id, token_hash: createHash('sha256').update(tokens[id]!).digest('hex'), created_at: 1 });
  }
  const config = parseLeaderConfig({ repo: { remoteUrl: 'file:///unused' }, admins: ['admin'] });
  const locks = new LockManager(db, { leaseSec: 120, deliver: () => {} });
  const handlers = new EventHandlers(db, config, locks);
  const scheduler = new Scheduler({ db, config, locks, handlers });
  const git = new LeaderGit(config.repo);
  const mergeWorker = new MergeWorker({ db, config, git, handlers });
  vi.spyOn(mergeWorker, 'kick').mockImplementation(() => {});
  vi.spyOn(scheduler, 'trigger').mockImplementation(() => {});
  registerRoutes(server, { db, config, locks, handlers, scheduler, mergeWorker, git, now: () => 100 });
});
afterEach(async () => { await server.close(); db.close(); });

describe('task transcript API', () => {
  it('uses task read visibility, returns metadata and ordered cursor pages, validates queries and missing tasks', async () => {
    const t = task();
    db.sessions.insert({ id: 's', agent_id: 'alice', profile: 'author', state: 'idle', created_at: 1, last_used_at: 1 });
    db.appendTranscript(t.id, 's', 'alice', 'author', [event, { ...event, seq: 3 }], 'turn', 10000);
    for (const token of [tokens.alice, tokens.bob, mintApiToken(db, 'alice', '', 1).token, mintApiToken(db, 'bob', '', 1, 'owner').token]) {
      const response = await request('GET', `/api/tasks/${t.id}/transcript?sid=s&afterSeq=1`, token);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ sessions: [{ sid: 's', agentId: 'alice', profile: 'author', events: [{ ...event, seq: 3 }] }] });
    }
    expect((await request('GET', `/api/tasks/${t.id}/transcript`)).statusCode).toBe(401);
    expect((await request('GET', '/api/tasks/999/transcript', tokens.alice)).statusCode).toBe(404);
    for (const query of ['afterSeq=-1', 'afterSeq=1.5', 'afterSeq=x', 'sid=', 'afterSeq=3', 'afterSeq=0']) {
      const response = await request('GET', `/api/tasks/${t.id}/transcript?${query}`, tokens.alice);
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('VALIDATION');
    }
    db.sessions.insert({ id: 'other', agent_id: 'bob', profile: 'reviewer', state: 'idle', created_at: 1, last_used_at: 1 });
    db.appendTranscript(t.id, 'other', 'bob', 'reviewer', [event], 'turn', 10000);
    const all = await request('GET', `/api/tasks/${t.id}/transcript`, tokens.alice);
    expect(all.json().sessions.map((session: { sid: string }) => session.sid)).toEqual(['other', 's']);
    expect((await request('GET', `/api/tasks/${t.id}/transcript?sid=s&afterSeq=3`, tokens.alice)).json().sessions[0].events).toEqual([]);
  });

  it('exposes reported agent trust and discovery while missing metadata stays unknown', async () => {
    const detectedAgents = [{ type: 'codex', version: '1.0', trust: 'sandboxed' }];
    db.agents.update('alice', { trust: 'low', detected_agents: JSON.stringify(detectedAgents), adapter_type: 'claude-code' });
    const response = await request('GET', '/api/agents', tokens.alice);
    expect(response.json().agents.find((a: { id: string }) => a.id === 'alice')).toMatchObject({ trust: 'low', detectedAgents, adapterType: 'claude-code' });
    expect(response.json().agents.find((a: { id: string }) => a.id === 'bob')).not.toHaveProperty('trust');
    expect(response.json().agents.find((a: { id: string }) => a.id === 'bob')).not.toHaveProperty('detectedAgents');
    expect(response.json().agents.find((a: { id: string }) => a.id === 'bob')).not.toHaveProperty('adapterType');
  });
});

describe('owner API tokens', () => {
  it('only lets full credentials mint either scope, returns the stored scope and tracks use', async () => {
    for (const scope of ['requester', 'owner']) {
      const response = await request('POST', '/api/tokens', tokens.alice, { scope });
      expect(response.statusCode).toBe(201);
      const minted = response.json() as { id: string; token: string; scope: string };
      expect(minted.scope).toBe(scope);
      expect(resolvePrincipal(db, minted.token)?.scope).toBe(scope);
      expect((await request('GET', '/api/tasks', minted.token)).statusCode).toBe(200);
      expect(db.apiTokens.require(minted.id).last_used_at).toBe(100);
      for (const requestedScope of ['requester', 'owner']) {
        expect((await request('POST', '/api/tokens', minted.token, { scope: requestedScope })).statusCode).toBe(403);
      }
      expect((await request('GET', '/api/tokens', minted.token)).statusCode).toBe(403);
      expect((await request('POST', `/api/tokens/${minted.id}/revoke`, minted.token, {})).statusCode).toBe(403);
    }
    expect((await request('POST', '/api/tokens', tokens.alice, {})).json().scope).toBe('requester');
    expect((await request('POST', '/api/tokens', tokens.alice, { scope: 'full' })).statusCode).toBe(400);
  });

  it.each(['approve', 'send-back', 'pause', 'cancel'])('lets an owner token %s its own requested task with token audit identity', async (action) => {
    const t = task('alice-other', action === 'approve' || action === 'send-back' ? 'ESCALATED' : 'QUEUED');
    const token = mintApiToken(db, 'alice', '', 1, 'owner').token;
    const response = await request('POST', `/api/tasks/${t.id}/${action}`, token, action === 'send-back' ? { comment: 'fix' } : {});
    expect(response.statusCode).toBe(200);
    expect(db.taskEvents.find({ task_id: t.id }).some((row) => row.actor === 'token:alice')).toBe(true);
    expect(db.tasks.require(t.id).state).toBe(action === 'approve' ? 'MERGE_QUEUED' : action === 'cancel' ? 'CANCELLED' : 'PAUSED');
  });

  it.each(['approve', 'send-back', 'pause', 'cancel'])('denies %s on other owners tasks, allowing admin owner tokens', async (action) => {
    const t = task('bob', action === 'approve' || action === 'send-back' ? 'ESCALATED' : 'QUEUED');
    const payload = action === 'send-back' ? { comment: 'fix' } : {};
    expect((await request('POST', `/api/tasks/${t.id}/${action}`, mintApiToken(db, 'alice', '', 1, 'owner').token, payload)).statusCode).toBe(403);
    expect((await request('POST', `/api/tasks/${t.id}/${action}`, mintApiToken(db, 'admin', '', 1, 'owner').token, payload)).statusCode).toBe(200);
    expect(db.taskEvents.find({ task_id: t.id }).some((row) => row.actor === 'token:admin')).toBe(true);
  });

  it('enforces every route scope flag before invoking the route handler', async () => {
    for (const scope of ['requester', 'owner'] as const) {
      const token = mintApiToken(db, 'alice', '', 1, scope).token;
      for (const name of Object.keys(API_ROUTES) as ApiRouteName[]) {
        const route = API_ROUTES[name];
        if (route.auth === 'none') continue;
        const allowed = scope === 'owner' ? 'ownerToken' in route && route.ownerToken : 'requesterToken' in route && route.requesterToken;
        if (allowed) continue;
        const response = await server.inject({ method: route.method, url: route.path.replace(':id', '999'), headers: { authorization: `Bearer ${token}` } });
        expect(response.statusCode, `${scope} ${name}`).toBe(403);
      }
    }
  });

  it('audits owner token task edits and resume requests, including a resume waiting for an offline author', async () => {
    const token = mintApiToken(db, 'alice', '', 1, 'owner').token;
    const queued = task();
    expect((await request('PATCH', `/api/tasks/${queued.id}`, token, { priority: 3 })).statusCode).toBe(200);
    expect(db.taskEvents.find({ task_id: queued.id, reason: 'task_updated' })).toEqual([expect.objectContaining({ actor: 'token:alice', data: '{"priority":3}' })]);
    for (const from of ['QUEUED', 'AUTHORING']) {
      const paused = task('alice', 'PAUSED');
      db.tasks.update(paused.id, { paused_from_state: from, pause_reason: 'human' });
      expect((await request('POST', `/api/tasks/${paused.id}/resume`, token, {})).statusCode).toBe(200);
      expect(db.taskEvents.find({ task_id: paused.id, reason: 'resume_requested' })).toEqual([expect.objectContaining({ actor: 'token:alice' })]);
      expect(db.tasks.require(paused.id).state).toBe(from === 'QUEUED' ? 'QUEUED' : 'PAUSED');
    }
  });

  it('rejects unknown stored scopes, revoked tokens and tokens belonging to revoked agents', () => {
    const minted = mintApiToken(db, 'alice', '', 1, 'owner');
    db.apiTokens.update(minted.row.id, { scope: 'full' });
    expect(resolvePrincipal(db, minted.token)).toBeNull();
    db.apiTokens.update(minted.row.id, { scope: 'owner', revoked_at: 2 });
    expect(resolvePrincipal(db, minted.token)).toBeNull();
    db.apiTokens.update(minted.row.id, { revoked_at: null });
    db.agents.update('alice', { revoked: 1 });
    expect(resolvePrincipal(db, minted.token)).toBeNull();
  });
});
