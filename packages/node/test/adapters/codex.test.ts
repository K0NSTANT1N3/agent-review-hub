import { AgentEventSchema } from '@quorum/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lstatSync, mkdtempSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexAdapter, parseResetAt, prepareCodexHome } from '../../src/adapters/codex.js';
import { createAdapter } from '../../src/adapters/index.js';
import type { AgentEventInput, Profile } from '../../src/adapters/types.js';
import { expectedSpawnOptions, fixture, jsonLines, replaySpawn, ReplayProcess, turn } from './cli-fixtures.js';

afterEach(() => vi.useRealTimers());

const threadId = '01a15b11-f651-70a0-a2e6-9291f3c055a2';
const config = { type: 'codex', contextWindow: 200_000 } as const;
const completed = { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } };
const message = (text: string) => ({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } });
const transcript = (...events: unknown[]) => jsonLines({ type: 'thread.started', thread_id: threadId }, ...events, completed);

describe('Codex adapter', () => {
  it('replays both captures with ordered tools, final text, session recall and raw usage', async () => {
    const replay = replaySpawn([fixture('codex-t1'), fixture('codex-t2')]);
    const adapter = createCodexAdapter(config, replay);
    expect(await adapter.createSession({ cwd: '/work/repo', profile: 'author' })).toEqual({ nativeId: null });
    const first: AgentEventInput[] = [];
    const result = await turn(adapter, { onEvent: (event) => first.push(event) });
    expect(result).toMatchObject({ nativeId: threadId, text: 'DONE 3', usage: { inputTokens: 107_008, outputTokens: 339 } });
    expect(result.contextTokens).toBeGreaterThan(0);
    expect(result.contextTokens).toBeLessThan(result.usage.inputTokens);
    expect(first.map((event) => event.kind)).toEqual([
      'text', 'tool_call', 'tool_result', 'tool_call', 'tool_call', 'tool_result', 'tool_result',
      'tool_call', 'tool_result', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'text', 'usage',
    ]);
    first.forEach((event, index) => AgentEventSchema.parse({ ...event, seq: index + 1, at: 0 }));
    const calls = first.filter((event) => event.kind === 'tool_call');
    const results = first.filter((event) => event.kind === 'tool_result');
    expect(calls.map((event) => event.toolKind)).toEqual(['bash', 'bash', 'bash', 'bash', 'edit', 'bash']);
    expect(results.map((event) => event.id).sort()).toEqual(calls.map((event) => event.id).sort());
    expect(results.find((event) => event.exitCode === 1)).toMatchObject({ ok: false, output: '' });
    expect(calls[4]).toMatchObject({ name: 'file_change', paths: ['/work/repo/math.js'] });
    expect(results.find((event) => event.id === calls[4]!.id)).toEqual({ kind: 'tool_result', id: calls[4]!.id, ok: true, output: '' });
    expect(results.at(-1)).toMatchObject({ ok: true, exitCode: 0, output: '3\n' });
    expect(first.at(-1)).toEqual({ kind: 'usage', inputTokens: 107_008, outputTokens: 339 });
    const second: AgentEventInput[] = [];
    const resumed = await turn(adapter, { nativeId: result.nativeId, onEvent: (event) => second.push(event) });
    expect(resumed).toMatchObject({ nativeId: threadId, text: 'subtract', usage: { inputTokens: 143_706, outputTokens: 357 } });
    expect(resumed.contextTokens).toBeGreaterThan(result.contextTokens);
    expect(second.map((event) => event.kind)).toEqual(['text', 'usage']);
    expect(replay.calls[1]![1].slice(0, 3)).toEqual(['exec', 'resume', threadId]);
    await adapter.closeSession(threadId);
  });

  it.each<Profile>(['author', 'reviewer', 'directive'])('sets the %s sandbox on fresh and resumed turns', async (profile) => {
    const replay = replaySpawn([fixture('codex-t2'), fixture('codex-t2')]);
    const adapter = createCodexAdapter({ ...config, binaryPath: '/custom/codex', model: 'test-model' }, replay);
    const prompt = '-literal $(prompt); text';
    await turn(adapter, { profile, prompt });
    await turn(adapter, { nativeId: threadId, profile, prompt });
    const sandbox = profile === 'author' ? 'workspace-write' : 'read-only';
    expect(replay.calls[0]).toEqual(['/custom/codex', [
      'exec', '--json', '-s', sandbox, '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '-C', '/work/repo', '-m', 'test-model', '--', prompt,
    ], expectedSpawnOptions('/work/repo')]);
    expect(replay.calls[1]![1]).toEqual([
      'exec', 'resume', threadId, '--json', '-c', `sandbox_mode="${sandbox}"`, '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '-m', 'test-model', '--', prompt,
    ]);
  });

  it('namespaces reused item ids across turns and adapter restarts', async () => {
    const events: AgentEventInput[] = [];
    const replay = replaySpawn([fixture('codex-t1'), fixture('codex-t1'), fixture('codex-t1')]);
    const adapter = createCodexAdapter(config, replay);
    const onEvent = (event: AgentEventInput) => events.push(event);
    await turn(adapter, { onEvent });
    await turn(adapter, { nativeId: threadId, onEvent });
    await turn(createCodexAdapter(config, replay), { nativeId: threadId, onEvent });
    const ids = events.filter((event) => event.kind === 'tool_call').map((event) => event.id);
    expect(ids).toHaveLength(18);
    expect(new Set(ids).size).toBe(18);
  });

  it('splits final text and bounds summaries, paths and UTF-8 tool output', async () => {
    const text = '😀'.repeat(10_000);
    const item = { id: 'item_2', type: 'file_change', changes: Array.from({ length: 25 }, () => ({ path: 'a'.repeat(1100), kind: 'update' })) };
    const replay = replaySpawn([transcript(
      { type: 'item.started', item },
      { type: 'item.completed', item: { ...item, status: 'completed' } },
      { type: 'item.completed', item: { id: 'item_3', type: 'command_execution', aggregated_output: '界'.repeat(3_000), status: 'completed' } },
      message(text),
    )]);
    const events: AgentEventInput[] = [];
    const result = await turn(createCodexAdapter(config, replay), { onEvent: (event) => events.push(event) });
    expect(result.text).toBe(text);
    events.forEach((event, index) => AgentEventSchema.parse({ ...event, seq: index + 1, at: 0 }));
    const chunks = events.filter((event) => event.kind === 'text');
    expect(chunks).toHaveLength(2);
    expect(new Set(chunks.map((event) => event.messageId)).size).toBe(1);
    expect(chunks.map((event) => event.text).join('')).toBe(text);
    expect(events[0]).toMatchObject({ argsSummary: expect.any(String), paths: expect.any(Array) });
    expect(events[2]).toMatchObject({ output: '界'.repeat(1_365) });
  });

  it.each([
    { stdout: transcript(message('usage limit reached')), stderr: '' },
    { stdout: transcript(message('normal reply')), stderr: 'rate limit reached' },
    { stdout: jsonLines({ type: 'turn.failed', error: { message: 'HTTP 429' } }), stderr: '' },
  ])('maps rate limits from agent text, stderr and failures', async ({ stdout, stderr }) => {
    const replay = replaySpawn([stdout], stderr, 1);
    await expect(turn(createCodexAdapter(config, replay))).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('accepts successful work that discusses rate limits and HTTP 429', async () => {
    const text = 'Implemented rate limit handling for HTTP 429 and usage limits.';
    const replay = replaySpawn([transcript(message(text))], 'test case: rate limit');
    expect(await turn(createCodexAdapter(config, replay))).toMatchObject({ text });
  });

  it('rejects incomplete turns and reports the stderr tail plus malformed lines', async () => {
    const replay = replaySpawn(['not JSON\n' + jsonLines(message('partial'))], 'diagnostic tail', 2);
    await expect(turn(createCodexAdapter(config, replay))).rejects.toMatchObject({
      code: 'ADAPTER_ERROR', message: expect.stringContaining('diagnostic tail'),
    });
    await expect(turn(createCodexAdapter(config, replaySpawn([jsonLines(completed)])))).rejects.toMatchObject({ code: 'ADAPTER_ERROR' });
    await expect(turn(createCodexAdapter(config, replaySpawn([transcript()])))).rejects.toMatchObject({ code: 'ADAPTER_ERROR' });
    await expect(turn(createCodexAdapter(config, replaySpawn([jsonLines({ type: 'thread.started', thread_id: threadId }, message('partial'))])))).rejects.toMatchObject({ code: 'ADAPTER_ERROR' });
  });

  it('tolerates NULs, malformed lines and unrelated JSON without losing completion', async () => {
    const replay = replaySpawn(['garbage\nnull\n[]\n42\n' + transcript(message('DONE 3')).replaceAll('\n', '\0\n')]);
    expect(await turn(createCodexAdapter(config, replay))).toMatchObject({ text: 'DONE 3' });
  });

  it.each(['CANCELLED', 'TIMEOUT'] as const)('maps %s after stopping the child', async (code) => {
    vi.useFakeTimers();
    const child = new ReplayProcess();
    const controller = new AbortController();
    const adapter = createCodexAdapter(config, { spawnFn: () => child });
    const rejected = expect(turn(adapter, { signal: controller.signal, timeoutMs: 10 })).rejects.toMatchObject({ code });
    if (code === 'CANCELLED') controller.abort();
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('registers Codex lazily without launching a turn', async () => {
    const adapter = await createAdapter(config);
    expect(await adapter.createSession({ cwd: '/repo', profile: 'reviewer' })).toEqual({ nativeId: null });
    await expect(createAdapter({ type: 'kilo', contextWindow: 200_000 })).rejects.toThrow('kilo adapter not implemented yet');
  });

  describe('owner config isolation', () => {
    const dirs: string[] = [];
    const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), 'quorum-codex-')); dirs.push(dir); return dir; };
    afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

    it('runs turns with a Quorum Codex home that holds only a link to the owner login', async () => {
      const owner = tempDir();
      writeFileSync(join(owner, 'auth.json'), '{}');
      writeFileSync(join(owner, 'config.toml'), 'approvals_reviewer = "auto_review"');
      writeFileSync(join(owner, 'AGENTS.md'), 'read my vault');
      const homeDir = join(tempDir(), 'codex-home');
      vi.stubEnv('CODEX_HOME', owner);
      const replay = replaySpawn([fixture('codex-t2')]);
      await turn(createCodexAdapter(config, { ...replay, homeDir }), { profile: 'reviewer' });
      expect(replay.calls[0]![2].env.CODEX_HOME).toBe(homeDir);
      expect(readlinkSync(join(homeDir, 'auth.json'))).toBe(join(owner, 'auth.json'));
      expect(lstatSync(join(homeDir, 'config.toml'), { throwIfNoEntry: false })).toBeUndefined();
      expect(lstatSync(join(homeDir, 'AGENTS.md'), { throwIfNoEntry: false })).toBeUndefined();
      expect(statSync(homeDir).mode & 0o077).toBe(0);
      vi.unstubAllEnvs();
    });

    it('relinks a stale login and refuses the owner home itself', () => {
      const owner = tempDir();
      writeFileSync(join(owner, 'auth.json'), '{}');
      const homeDir = tempDir();
      writeFileSync(join(homeDir, 'auth.json'), 'stale copy');
      prepareCodexHome(homeDir, owner);
      expect(readlinkSync(join(homeDir, 'auth.json'))).toBe(join(owner, 'auth.json'));
      expect(() => prepareCodexHome(owner, owner)).toThrow(/must differ/);
    });

    it('redacts auth.json secrets from every emitted event and error details', async () => {
      const owner = tempDir();
      const token = 'sk-live-secret-token-32';
      const refresh = 'refresh-token-value-ok';
      writeFileSync(join(owner, 'auth.json'), JSON.stringify({
        tokens: { access: token, nested: { refresh } },
        short: 'tiny-value',
      }));
      const homeDir = join(tempDir(), 'codex-home');
      vi.stubEnv('CODEX_HOME', owner);
      const replay = replaySpawn([transcript(
        { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: `cat ${token}` } },
        { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', aggregated_output: `${token}\n${refresh}`, status: 'completed', exit_code: 0 } },
        { type: 'item.started', item: { id: 'item_2', type: 'file_change', changes: [{ path: `/tmp/${token}.json`, kind: 'add' }] } },
        { type: 'item.completed', item: { id: 'item_2', type: 'file_change', changes: [{ path: `/tmp/${token}.json`, kind: 'add' }], status: 'completed' } },
        message(`token is ${token}`),
      )]);
      const events: AgentEventInput[] = [];
      await turn(createCodexAdapter(config, { ...replay, homeDir }), { onEvent: (event) => events.push(event) });
      const blob = JSON.stringify(events);
      expect(blob).not.toContain(token);
      expect(blob).not.toContain(refresh);
      expect(blob).toContain('[redacted]');
      const failed = replaySpawn(['not JSON\n'], `login ${token} failed`, 1);
      await expect(turn(createCodexAdapter(config, { ...failed, homeDir }))).rejects.toMatchObject({
        code: 'ADAPTER_ERROR',
        message: expect.not.stringContaining(token),
      });
      vi.unstubAllEnvs();
    });

    it('leaves no prefix of a secret that straddles the tool output cut', async () => {
      const owner = tempDir();
      const token = 'sk-live-0123456789abcdefghij';
      writeFileSync(join(owner, 'auth.json'), JSON.stringify({ token }));
      vi.stubEnv('CODEX_HOME', owner);
      // The cut at 4096 bytes would keep the first 10 characters of the raw token.
      const output = `${'x'.repeat(4086)}${token}`;
      const replay = replaySpawn([transcript(
        { type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'cat auth.json' } },
        { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', aggregated_output: output, status: 'completed', exit_code: 0 } },
        message('done'),
      )]);
      const events: AgentEventInput[] = [];
      await turn(createCodexAdapter(config, { ...replay, homeDir: join(tempDir(), 'codex-home') }), { onEvent: (event) => events.push(event) });
      expect(events.some((event) => event.kind === 'tool_result')).toBe(true);
      expect(JSON.stringify(events)).not.toContain('sk-live-0');
      vi.unstubAllEnvs();
    });

    it('fails the turn clearly when the owner is not logged in', async () => {
      const replay = replaySpawn([fixture('codex-t2')]);
      vi.stubEnv('CODEX_HOME', tempDir());
      await expect(turn(createCodexAdapter(config, { ...replay, homeDir: join(tempDir(), 'h') }))).rejects.toMatchObject({ code: 'ADAPTER_ERROR', message: expect.stringMatching(/codex login/) });
      expect(replay.calls).toHaveLength(0);
      vi.unstubAllEnvs();
    });
  });

  it('maps the captured usage-limit failure to RATE_LIMITED with the reset time', async () => {
    const replay = replaySpawn([fixture('codex-usage-limit')], '', 1);
    await expect(turn(createCodexAdapter(config, replay))).rejects.toMatchObject({ code: 'RATE_LIMITED', resetAt: expect.any(Number) });
  });

  it('reads "try again at" times as the next matching local time', () => {
    const now = new Date(2026, 9, 21, 1, 48).getTime();
    expect(parseResetAt('try again at 5:02 AM.', now)).toBe(new Date(2026, 9, 21, 5, 2).getTime());
    expect(parseResetAt('try again at 1:30 AM', now)).toBe(new Date(2026, 9, 22, 1, 30).getTime());
    expect(parseResetAt('try again at 12:15 PM', now)).toBe(new Date(2026, 9, 21, 12, 15).getTime());
    expect(parseResetAt('try again at 17:05', now)).toBe(new Date(2026, 9, 21, 17, 5).getTime());
    expect(parseResetAt('try again at 13:00 PM', now)).toBeUndefined();
    expect(parseResetAt('usage limit reached', now)).toBeUndefined();
  });
});
