import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { E2E_READY, Harness, aliceAndBob } from '../helpers/harness.js';
import { anyTask, approve, authorBlocked, authorDone, authorRevised, directiveAnswer, forTask } from '../helpers/mock-script.js';
import { GREET } from '../helpers/toy-project.js';

// The `quorum` CLI (packages/cli, built) driven as a coding agent would: JSON on stdout, branching on exit codes.

const CLI = fileURLToPath(new URL('../../packages/cli/dist/cli.js', import.meta.url));

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function quorum(args: string[], env: Record<string, string>, stdin?: string): Promise<Result> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [CLI, ...args], { env: { PATH: process.env.PATH ?? '', ...env }, timeout: 60_000 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      resolve({ code, stdout, stderr });
    });
    child.stdin?.end(stdin ?? '');
  });
}

const json = (r: Result): Record<string, unknown> => JSON.parse(r.stdout) as Record<string, unknown>;

describe.skipIf(!E2E_READY)('quorum CLI', () => {
  let h: Harness;
  afterEach(async () => h?.close());

  it('#24 an agent creates a task, answers the blocked author, waits for the merge and asks a teammate', async () => {
    h = await Harness.create();
    const { alice } = await aliceAndBob(h, {
      alice: {
        author: [
          forTask('Slow', [{ ...authorDone({ 'src/greet.js': GREET.variantA }), delayMs: 30_000 }]),
          ...anyTask([
            authorBlocked('Should greet() default to "world" or throw?'),
            authorRevised({ 'src/greet.js': GREET.withDefault }, [{ issue: 'I1', action: 'fixed', note: 'used world' }]),
          ]),
        ],
      },
      bob: { reviewer: anyTask([approve([{ issue: 'I1', status: 'resolved' }])]), directive: anyTask([directiveAnswer('greet() lives in src/greet.js')]) },
    });
    const { token } = await alice.api.call('createApiToken', { body: { label: 'e2e agent' } });
    const env = { QUORUM_CONFIG: join(h.dir, 'cli.json'), QUORUM_POLL_MS: '200' };

    // Not logged in, then a bad token: exit 6.
    expect((await quorum(['agents'], env)).code).toBe(6);
    expect((await quorum(['agents', '--url', h.httpUrl, '--token', 'qrq_nope'], env)).code).toBe(6);

    // `login` reads the token from stdin, accepts the ws:// URL and saves an owner-only config.
    const login = await quorum(['login', '--url', `ws://127.0.0.1:${h.port}/ws/node`, '--token', '-', '--json'], env, `${token}\n`);
    expect(login.code, login.stderr).toBe(0);
    expect(statSync(env.QUORUM_CONFIG).mode & 0o777).toBe(0o600);

    const agents = await quorum(['agents', '--json'], env);
    expect(agents.code).toBe(0);
    expect((JSON.parse(agents.stdout) as { id: string }[]).map((a) => a.id)).toEqual(['alice-claude', 'bob-claude']);

    // The author blocks on a question: `--wait` stops with exit 3 and the question in the JSON.
    const created = await quorum(['task', 'create', '--title', 'Default name', '--tags', 'greet', '--wait', '--json'], env, 'greet() with no name\n');
    expect(created.code, created.stderr).toBe(3);
    const blocked = json(created);
    expect(blocked).toMatchObject({ state: 'ESCALATED', outcome: 'needs_human', question: 'Should greet() default to "world" or throw?' });
    const id = String(blocked.id);

    const answer = await quorum(['task', 'answer', id, 'Default', 'to', '"world".'], env);
    expect(answer.code, answer.stderr).toBe(0);
    const merged = await quorum(['task', 'wait', id, '--json', '--timeout', '60'], env);
    expect(merged.code, merged.stderr).toBe(0);
    expect(json(merged)).toMatchObject({ state: 'MERGED', outcome: 'merged', author: 'alice-claude', reviewers: ['bob-claude'] });
    expect(json(merged).mergedCommit).toMatch(/^[0-9a-f]{40}$/);

    const diff = await quorum(['task', 'diff', id], env);
    expect(diff.code).toBe(0);
    expect(diff.stdout).toContain("name = 'world'");

    const list = await quorum(['task', 'list', '--json'], env);
    expect(json(list)).toEqual([expect.objectContaining({ id: Number(id), state: 'MERGED', requester: 'alice' })]);

    // Answering again is refused by the Leader (409): a plain error, exit 1.
    expect((await quorum(['task', 'answer', id, 'again'], env)).code).toBe(1);

    // Waiting gives up with exit 5 and says how to resume.
    const slow = await quorum(['task', 'create', '--title', 'Slow change', '--description', 'x', '--json'], env);
    const slowId = String(json(slow).id);
    const timedOut = await quorum(['task', 'wait', slowId, '--timeout', '1'], env);
    expect(timedOut.code).toBe(5);
    expect(timedOut.stdout).toContain(`quorum task wait ${slowId}`);

    const asked = await quorum(['ask', 'bob-claude', 'Where', 'is', 'greet?', '--json'], env);
    expect(asked.code, asked.stderr).toBe(0);
    expect(json(asked)).toMatchObject({ state: 'done', resultText: 'greet() lives in src/greet.js', requester: 'alice' });

    // Usage errors exit 2 without touching the Leader.
    expect((await quorum(['task', 'create', '--description', 'x'], env)).code).toBe(2);
    expect((await quorum(['task', 'status'], env)).code).toBe(2);
  });
});
