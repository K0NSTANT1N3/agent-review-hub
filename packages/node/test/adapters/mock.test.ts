import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AdapterConfig } from '@quorum/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdapter } from '../../src/adapters/index.js';
import { createMockAdapter } from '../../src/adapters/mock.js';
import { AdapterError, type AgentAdapter, type Profile } from '../../src/adapters/types.js';
import { seedSessionPrompt, summarizePrompt } from '../../src/prompts/index.js';

interface MockFixture {
  root: string;
  scriptPath: string;
  worktreesDir: string;
  makeWorktree(sid: string): Promise<string>;
  dispose(): Promise<void>;
}

const fixtures: MockFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

describe('mock adapter', () => {
  it('matches task titles, advances per (sid, taskId), writes files, and falls back to any', async () => {
    const fixture = await createFixture({
      author: [
        {
          match: { taskTitleContains: 'add greeting' },
          turns: [
            { writeFiles: { 'src/greet.js': 'export const greet = () => "hi";\n' }, reply: { summary: 'first' } },
            { reply: { summary: 'second' } },
          ],
        },
        { match: { any: true }, turns: [{ reply: { summary: 'fallback' } }] },
      ],
    });
    const adapter = await loadAdapter(fixture);
    const sidOne = await makeSession(adapter, fixture, 'sid-one', 'author');
    const firstPrompt = taskPrompt('12', 'Add greeting utility');

    const first = await run(adapter, sidOne, 'author', firstPrompt);
    expect(first.text).toBe('```quorum-json\n{"summary":"first"}\n```');
    expect(await readFile(join(sidOne.cwd, 'src/greet.js'), 'utf8')).toContain('greet');
    const second = await run(adapter, sidOne, 'author', firstPrompt);
    expect(second.text).toContain('{"summary":"second"}');
    const anotherTask = await run(adapter, sidOne, 'author', taskPrompt('13', 'Update styles'));
    expect(anotherTask.text).toContain('{"summary":"fallback"}');

    const sidTwo = await makeSession(adapter, fixture, 'sid-two', 'author');
    const independent = await run(adapter, sidTwo, 'author', firstPrompt);
    expect(independent.text).toContain('{"summary":"first"}');
  });

  it('emits rawReply verbatim and applies per-turn failTurnWith', async () => {
    const fixture = await createFixture({
      reviewer: [{
        match: { any: true },
        turns: [
          { rawReply: 'not a fenced response' },
          { failTurnWith: 'RATE_LIMITED' },
          { reply: { verdict: 'approve', summary: 'ok' } },
          { failTurnWith: 'INVALID_OUTPUT' },
        ],
      }],
    });
    const adapter = await loadAdapter(fixture);
    const session = await makeSession(adapter, fixture, 'sid-review', 'reviewer');
    const prompt = taskPrompt('4', 'Review API');

    expect((await run(adapter, session, 'reviewer', prompt)).text).toBe('not a fenced response');
    await expect(run(adapter, session, 'reviewer', prompt)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      resetAt: undefined,
    });
    expect((await run(adapter, session, 'reviewer', prompt)).text).toContain('```quorum-json');
    expect((await run(adapter, session, 'reviewer', prompt)).text).toBe('mock invalid output');
  });

  it('applies a global behavior failure and allows a per-turn null override', async () => {
    const fixture = await createFixture({
      author: [{ match: { any: true }, turns: [
        { reply: { summary: 'per-turn override' }, failTurnWith: null },
      ] }],
      behaviors: { failTurnWith: 'ADAPTER_ERROR' },
    });
    const adapter = await loadAdapter(fixture);
    const session = await makeSession(adapter, fixture, 'sid-failure', 'author');
    const result = await run(adapter, session, 'author', taskPrompt('6', 'Global failure'));
    expect(result.text).toContain('per-turn override');

    const globalFixture = await createFixture({
      author: [{ match: { any: true }, turns: [{ reply: { summary: 'not reached' } }] }],
      behaviors: { failTurnWith: 'RATE_LIMITED' },
    });
    const globalAdapter = await loadAdapter(globalFixture);
    const globalSession = await makeSession(globalAdapter, globalFixture, 'sid-global', 'author');
    await expect(run(globalAdapter, globalSession, 'author', taskPrompt('7', 'Global rate limit')))
      .rejects.toBeInstanceOf(AdapterError);
  });

  it('keeps directive rules independent from task rule lists', async () => {
    const fixture = await createFixture({
      author: [{ match: { any: true }, turns: [{ reply: { summary: 'author' } }] }],
      directive: [{ match: { any: true }, turns: [{ reply: { answer: '42' } }] }],
    });
    const adapter = await loadAdapter(fixture);
    const session = await makeSession(adapter, fixture, 'sid-directive', 'directive');
    const result = await run(adapter, session, 'directive', 'QUORUM-DIRECTIVE: directive-18\nAnswer this.');
    expect(result.text).toContain('{"answer":"42"}');
  });

  it('answers summarize and seed turns without consuming scripted turns and grows context tokens', async () => {
    const fixture = await createFixture({
      author: [{
        match: { taskTitleContains: 'compact feature' },
        turns: [
          { reply: { summary: 'first scripted reply' } },
          { reply: { summary: 'second scripted reply' } },
        ],
      }],
      behaviors: { tokensPerTurn: { input: 5, output: 2 } },
    });
    const adapter = await loadAdapter(fixture);
    const session = await makeSession(adapter, fixture, 'sid-compact', 'author');
    const task = { id: 8, title: 'Compact feature implementation' };
    const summarize = await run(adapter, session, 'author', summarizePrompt({
      worktree: session.cwd,
      profile: 'author',
      task,
    }));
    expect(summarize.text).toContain('{"summary":"mock summary"}');
    expect(summarize.contextTokens).toBe(5);

    const seed = await adapter.createSession({ cwd: session.cwd, profile: 'author' });
    const seeded = await run(adapter, { ...session, nativeId: seed.nativeId! }, 'author', seedSessionPrompt({
      worktree: session.cwd,
      profile: 'author',
      task,
      summary: 'Keep the current implementation details.',
    }));
    expect(seeded.text).toContain('{"summary":"mock session seeded"}');
    expect(seeded.contextTokens).toBe(5);

    const prompt = taskPrompt(String(task.id), task.title);
    const firstScripted = await run(adapter, { ...session, nativeId: seed.nativeId! }, 'author', prompt);
    expect(firstScripted.text).toContain('first scripted reply');
    expect(firstScripted.contextTokens).toBe(10);
    const secondScripted = await run(adapter, { ...session, nativeId: seed.nativeId! }, 'author', prompt);
    expect(secondScripted.text).toContain('second scripted reply');
    expect(secondScripted.contextTokens).toBe(15);
  });

  it('honors delay, cancellation, and timeout', async () => {
    const fixture = await createFixture({
      author: [{ match: { any: true }, turns: [{ reply: { summary: 'done' }, delayMs: 100 }] }],
    });
    const adapter = await loadAdapter(fixture);
    const session = await makeSession(adapter, fixture, 'sid-delay', 'author');
    const prompt = taskPrompt('9', 'Delayed work');

    await expect(run(adapter, session, 'author', prompt, { timeoutMs: 10 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    const abort = new AbortController();
    const pending = run(adapter, session, 'author', prompt, { signal: abort.signal, timeoutMs: 500 });
    setTimeout(() => abort.abort(), 10);
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });

    const globalDelayFixture = await createFixture({
      author: [{ match: { any: true }, turns: [{ reply: { summary: 'delayed by behavior' } }] }],
      behaviors: { delayMs: 100 },
    });
    const globalDelayAdapter = await loadAdapter(globalDelayFixture);
    const globalDelaySession = await makeSession(globalDelayAdapter, globalDelayFixture, 'sid-global-delay', 'author');
    await expect(run(globalDelayAdapter, globalDelaySession, 'author', taskPrompt('91', 'Global delay'), {
      timeoutMs: 10,
    })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('rejects file writes outside the worktree', async () => {
    const fixture = await createFixture({
      author: [{ match: { any: true }, turns: [{ writeFiles: { '../escape.txt': 'outside' }, reply: { summary: 'bad path' } }] }],
    });
    const adapter = await loadAdapter(fixture);
    const session = await makeSession(adapter, fixture, 'sid-path', 'author');
    await expect(run(adapter, session, 'author', taskPrompt('10', 'Write path')))
      .rejects.toMatchObject({ code: 'ADAPTER_ERROR' });
  });

  it('loads the mock adapter through the factory without importing provider adapters', async () => {
    const fixture = await createFixture({ author: [{ match: { any: true }, turns: [{ reply: { summary: 'works' } }] }] });
    const config: Extract<AdapterConfig, { type: 'mock' }> = {
      type: 'mock',
      scriptPath: fixture.scriptPath,
      contextWindow: 200000,
    };
    const adapter = await createAdapter(config);
    const session = await makeSession(adapter, fixture, 'sid-factory', 'author');
    expect((await run(adapter, session, 'author', taskPrompt('11', 'Factory'))).text).toContain('works');
  });
});

async function createFixture(script: unknown): Promise<MockFixture> {
  const root = await mkdtemp(join(tmpdir(), 'quorum-node-mock-'));
  const worktreesDir = join(root, 'worktrees');
  const scriptPath = join(root, 'mock-script.json');
  await writeFile(scriptPath, JSON.stringify(script), 'utf8');
  const fixture: MockFixture = {
    root,
    scriptPath,
    worktreesDir,
    async makeWorktree(sid) {
      const worktree = join(worktreesDir, sid);
      await mkdir(worktree, { recursive: true });
      return worktree;
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
  fixtures.push(fixture);
  return fixture;
}

async function loadAdapter(fixture: MockFixture): Promise<AgentAdapter> {
  return createMockAdapter({ type: 'mock', scriptPath: fixture.scriptPath, contextWindow: 200000 });
}

async function makeSession(
  adapter: AgentAdapter,
  fixture: MockFixture,
  sid: string,
  profile: Profile,
): Promise<{ nativeId: string; cwd: string }> {
  const cwd = await fixture.makeWorktree(sid);
  const result = await adapter.createSession({ cwd, profile });
  expect(result.nativeId).not.toBeNull();
  return { nativeId: result.nativeId!, cwd };
}

function run(
  adapter: AgentAdapter,
  session: { nativeId: string; cwd: string },
  profile: Profile,
  prompt: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
) {
  return adapter.runTurn({
    nativeId: session.nativeId,
    cwd: session.cwd,
    profile,
    prompt,
    signal: options.signal ?? new AbortController().signal,
    timeoutMs: options.timeoutMs ?? 1000,
  });
}

function taskPrompt(taskId: string, title: string): string {
  return `QUORUM-TASK: ${taskId} ${title}\nDo the task.`;
}
