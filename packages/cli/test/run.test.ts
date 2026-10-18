import { describe, expect, it } from 'vitest';
import type { TaskDetail, TaskView } from '@quorum/protocol';
import { normalizeLeaderUrl } from '../src/client.js';
import { outcomeOf } from '../src/format.js';
import { EXIT, run, type Deps } from '../src/run.js';

function taskView(patch: Partial<TaskView> = {}): TaskView {
  return {
    id: 7, title: 'T', description: 'd', tags: [], priority: 1, mode: 'own', requesterAgentId: 'ana-agent', requesterOwner: 'Ana',
    authorAgentId: 'ana-agent', authorSessionId: 's', state: 'AUTHORING', pausedFromState: null, pauseReason: null, escalationReason: null,
    branch: 'quorum/task-7', baseCommit: null, headCommit: null, lastReviewedCommit: null, reviewRound: 0, testFixAttempts: 0, syncAttempts: 0,
    files: [], diffLines: 0, lastTestOutput: null, mergedCommit: null, createdAt: 1, updatedAt: 1, stateEnteredAt: 1, approvedAt: null, ...patch,
  };
}

const detail = (patch: Partial<TaskView> = {}): TaskDetail => ({ task: taskView(patch), conversations: [], issues: [], events: [], messages: [] });

/** Runs the CLI against a fake Leader whose GET /api/tasks/7 returns `states` in turn. */
async function harness(argv: string[], respond: (url: URL, init: RequestInit) => { status: number; body: unknown }) {
  const out: string[] = [];
  const err: string[] = [];
  let clock = 0;
  const deps: Deps = {
    env: { QUORUM_URL: 'http://leader.test:7420', QUORUM_TOKEN: 'qrq_x', QUORUM_CONFIG: '/nonexistent/cli.json', QUORUM_POLL_MS: '1000' },
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    readStdin: async () => '',
    stdinIsTTY: true,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const { status, body } = respond(new URL(String(input)), init ?? {});
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  };
  const code = await run(argv, deps);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('outcomeOf', () => {
  it('maps states to what the caller does next', () => {
    expect(outcomeOf(taskView({ state: 'MERGED' }))).toBe('merged');
    expect(outcomeOf(taskView({ state: 'FAILED' }))).toBe('failed');
    expect(outcomeOf(taskView({ state: 'CANCELLED' }))).toBe('failed');
    expect(outcomeOf(taskView({ state: 'ESCALATED' }))).toBe('needs_human');
    expect(outcomeOf(taskView({ state: 'PAUSED', pauseReason: 'human' }))).toBe('needs_human');
    expect(outcomeOf(taskView({ state: 'PAUSED', pauseReason: 'rate_limited' }))).toBe('pending');
    expect(outcomeOf(taskView({ state: 'IN_REVIEW' }))).toBe('pending');
  });
});

describe('quorum task wait', () => {
  it('polls until merged and exits 0', async () => {
    const states = ['AUTHORING', 'IN_REVIEW', 'MERGED'] as const;
    let i = 0;
    const r = await harness(['task', 'wait', '7', '--json'], () => ({ status: 200, body: detail({ state: states[Math.min(i++, 2)]! }) }));
    expect(r.code).toBe(EXIT.OK);
    expect(JSON.parse(r.out)).toMatchObject({ id: 7, state: 'MERGED', outcome: 'merged' });
  });

  it('exits 3 with the question when the author is blocked', async () => {
    const r = await harness(['task', 'wait', '7'], () => ({ status: 200, body: detail({ state: 'ESCALATED', escalationReason: 'author_blocked: Which DB?' }) }));
    expect(r.code).toBe(EXIT.NEEDS_HUMAN);
    expect(r.out).toContain('Which DB?');
    expect(r.out).toContain('quorum task answer 7');
  });

  it('exits 4 when the task failed and 5 on timeout', async () => {
    expect((await harness(['task', 'wait', '7'], () => ({ status: 200, body: detail({ state: 'FAILED' }) }))).code).toBe(EXIT.FAILED);
    const slow = await harness(['task', 'wait', '7', '--timeout', '3', '--json'], () => ({ status: 200, body: detail() }));
    expect(slow.code).toBe(EXIT.TIMEOUT);
    expect(JSON.parse(slow.out)).toMatchObject({ timedOut: true, state: 'AUTHORING' });
  });
});

describe('errors', () => {
  it('maps 401/403 to exit 6 and prints a JSON error with --json', async () => {
    const r = await harness(['task', 'status', '7', '--json'], () => ({ status: 403, body: { error: 'FORBIDDEN', message: 'nope' } }));
    expect(r.code).toBe(EXIT.AUTH);
    expect(JSON.parse(r.out)).toEqual({ error: 'FORBIDDEN', message: 'nope' });
  });

  it('rejects bad arguments with exit 2 before calling the Leader', async () => {
    let called = false;
    const respond = () => {
      called = true;
      return { status: 200, body: {} };
    };
    expect((await harness(['task', 'create', '--title', 'x', '--priority', 'asap', '--description', 'd'], respond)).code).toBe(EXIT.USAGE);
    expect((await harness(['task', 'wait', 'abc'], respond)).code).toBe(EXIT.USAGE);
    expect((await harness(['task', 'list', '--bogus'], respond)).code).toBe(EXIT.USAGE);
    expect(called).toBe(false);
  });

  it('sends the bearer token and the protocol body', async () => {
    let seen: { url: string; auth: string | undefined; body: unknown } | null = null;
    const r = await harness(['task', 'create', '--title', 'Add rate limit', '--description', 'd', '--tags', 'a, b', '--priority', 'high', '--mode', 'pool'], (url, init) => {
      seen = { url: url.pathname, auth: (init.headers as Record<string, string>).authorization, body: JSON.parse(String(init.body)) };
      return { status: 201, body: taskView({ state: 'QUEUED' }) };
    });
    expect(r.code).toBe(EXIT.OK);
    expect(seen).toEqual({ url: '/api/tasks', auth: 'Bearer qrq_x', body: { title: 'Add rate limit', description: 'd', tags: ['a', 'b'], priority: 2, mode: 'pool' } });
  });
});

describe('normalizeLeaderUrl', () => {
  it('accepts http(s) bases and the ws(s) node URL', () => {
    expect(normalizeLeaderUrl('ws://10.0.0.5:7420/ws/node')).toBe('http://10.0.0.5:7420');
    expect(normalizeLeaderUrl('wss://quorum.example.com/ws/node')).toBe('https://quorum.example.com');
    expect(normalizeLeaderUrl('http://host:7420/')).toBe('http://host:7420');
    expect(() => normalizeLeaderUrl('ftp://host')).toThrow();
  });
});
