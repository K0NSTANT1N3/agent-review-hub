import { homedir } from 'node:os';
import { AgentEventSchema } from '@quorum/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdapter } from '../../src/adapters/index.js';
import { createPiAdapter } from '../../src/adapters/pi.js';
import { AdapterError, type AgentEventInput, type Profile } from '../../src/adapters/types.js';
import { expectedSpawnOptions, fixture, jsonLines, replaySpawn, ReplayProcess, turn } from './cli-fixtures.js';

afterEach(() => vi.useRealTimers());

const config = (type: 'pi' | 'omp') => ({ type, contextWindow: 200_000 });
const assistant = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'message_end', message: {
    role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop',
    usage: { input: 10, output: 2, totalTokens: 12 }, ...extra,
  },
});
const transcript = (...events: unknown[]) => jsonLines({ type: 'session', id: 'session-1' }, ...events, { type: 'agent_end', willRetry: false });

describe.each(['pi', 'omp'] as const)('%s adapter', (type) => {
  it('replays both captures with final text, native session recall and one usage per assistant', async () => {
    const replay = replaySpawn([fixture(`${type}-t1`), fixture(`${type}-t2`)]);
    const adapter = createPiAdapter(config(type), replay);
    const session = await adapter.createSession({ cwd: '/work/repo', profile: 'author' });
    if (type === 'pi') expect(session.nativeId).toMatch(/^[0-9a-f-]{36}$/);
    else expect(session.nativeId).toBeNull();
    const first: AgentEventInput[] = [];
    const result = await turn(adapter, { nativeId: session.nativeId, onEvent: (event) => first.push(event) });
    const expectedId = type === 'pi' ? 'spike-pi-0002' : '01a15b11-f84e-7000-bae0-49c19c7f0989';
    expect(result).toEqual({
      nativeId: expectedId, text: 'DONE 3',
      usage: type === 'pi' ? { inputTokens: 18_096, outputTokens: 187 } : { inputTokens: 32_123, outputTokens: 111 },
      contextTokens: type === 'pi' ? 17_902 : 32_069,
    });
    expect(first.map((event) => event.kind)).toEqual(type === 'pi' ? [
      'usage', 'tool_call', 'tool_result', 'usage', 'tool_call', 'tool_result',
      'usage', 'tool_call', 'tool_result', 'usage', 'tool_call', 'tool_result', 'text', 'text', 'text', 'text', 'usage',
    ] : [
      'usage', 'tool_call', 'tool_result', 'usage', 'tool_call', 'tool_result',
      'usage', 'tool_call', 'tool_result', 'text', 'text', 'text', 'usage',
    ]);
    first.forEach((event, index) => AgentEventSchema.parse({ ...event, seq: index + 1, at: 0 }));
    const calls = first.filter((event) => event.kind === 'tool_call');
    const results = first.filter((event) => event.kind === 'tool_result');
    expect(results.map((event) => event.id)).toEqual(calls.map((event) => event.id));
    expect(calls.map((event) => event.toolKind)).toEqual(type === 'pi' ? ['read', 'edit', 'edit', 'bash'] : ['read', 'edit', 'bash']);
    expect(calls[0]).toMatchObject({ name: 'read', argsSummary: 'math.js', paths: ['math.js'] });
    const textEvents = first.filter((event) => event.kind === 'text');
    expect(new Set(textEvents.map((event) => event.messageId)).size).toBe(1);
    expect(textEvents.at(-1)).toMatchObject({ mode: 'final', text: 'DONE 3' });
    expect(results.at(-1)).toMatchObject({ ok: true, output: expect.stringContaining('3\n') });
    if (type === 'pi') {
      expect(replay.calls[0]![1]).toContain(session.nativeId);
      expect(results[1]).toMatchObject({ ok: false, output: 'oldText must not be empty in math.js.' });
      expect(results.at(-1)).toMatchObject({ exitCode: 0 });
    } else {
      expect(replay.calls[0]![1]).not.toContain('--resume');
      expect(calls[1]).not.toHaveProperty('paths');
      expect(calls[1]!.id).toContain('|');
      expect(results.at(-1)).not.toHaveProperty('exitCode');
    }
    const second: AgentEventInput[] = [];
    const resumed = await turn(adapter, { nativeId: result.nativeId, onEvent: (event) => second.push(event) });
    expect(resumed).toEqual({
      nativeId: expectedId, text: 'subtract',
      usage: type === 'pi' ? { inputTokens: 14_105, outputTokens: 3 } : { inputTokens: 10_607, outputTokens: 4 },
      contextTokens: type === 'pi' ? 14_108 : 10_611,
    });
    expect(second.map((event) => event.kind)).toEqual(type === 'pi' ? ['text', 'text', 'usage'] : ['thinking', 'text', 'text', 'usage']);
    expect(second.filter((event) => event.kind === 'thinking')).toEqual(type === 'pi' ? [] : [{ kind: 'thinking', text: 'subtract', messageId: expect.any(String) }]);
    const sessionFlag = type === 'pi' ? '--session-id' : '--resume';
    const argv = replay.calls[1]![1];
    expect(argv[argv.indexOf(sessionFlag) + 1]).toBe(expectedId);
    await adapter.closeSession(expectedId);
  });

  it.each<Profile>(['author', 'reviewer', 'directive'])('reapplies %s tools and non-interactive flags on every turn', async (profile) => {
    const replay = replaySpawn([fixture(`${type}-t2`), fixture(`${type}-t2`)]);
    const adapter = createPiAdapter({ ...config(type), binaryPath: `/custom/${type}`, model: 'test-model' }, replay);
    const nativeId = (await adapter.createSession({ cwd: '/work/repo', profile })).nativeId;
    const result = await turn(adapter, { nativeId, profile, prompt: '-literal $(prompt); text' });
    await turn(adapter, { nativeId: result.nativeId, profile });
    for (const [binary, argv, options] of replay.calls) {
      expect(binary).toBe(`/custom/${type}`);
      expect(options).toEqual(expectedSpawnOptions('/work/repo'));
      expect(argv.slice(0, 5)).toEqual(['--mode', 'json', '-p', '--no-extensions', '--no-skills']);
      expect(argv[argv.indexOf('--model') + 1]).toBe('test-model');
      expect(argv.at(-2)).toBe('--');
      if (profile === 'author') expect(argv).not.toContain('--tools');
      else expect(argv[argv.indexOf('--tools') + 1]).toBe(type === 'pi' ? 'read,grep,find,ls' : 'read,grep,glob');
      if (type === 'pi') {
        expect(argv).toContain('--no-mcp');
        expect(argv).toContain('--no-context-files');
        expect(argv).not.toContain('--resume');
      } else {
        expect(argv).toContain('--no-lsp');
        expect(argv).toContain('--no-pty');
        expect(argv).not.toContain('--no-mcp');
        if (profile === 'author') {
          expect(argv).toContain('--auto-approve');
          expect(argv).not.toContain('--approval-mode');
        } else {
          expect(argv).not.toContain('--auto-approve');
          expect(argv[argv.indexOf('--approval-mode') + 1]).toBe('always-ask');
        }
      }
    }
    expect(replay.calls[0]![1].at(-1)).toBe('-literal $(prompt); text');
  });

  it('counts duplicate assistant message_end only once and ignores repeated accounting elsewhere', async () => {
    const reply = assistant('done', { responseId: 'response-1' });
    const replay = replaySpawn([transcript(
      { type: 'message_start', message: { role: 'assistant' } }, reply, reply,
      { type: 'message_end', message: { role: 'user', usage: { input: 900, output: 900 } } },
      { type: 'turn_end', message: reply.message },
      { type: 'agent_end', messages: [reply.message] },
    )]);
    const events: AgentEventInput[] = [];
    expect(await turn(createPiAdapter(config(type), replay), { onEvent: (event) => events.push(event) })).toMatchObject({ text: 'done', usage: { inputTokens: 10, outputTokens: 2 }, contextTokens: 12 });
    expect(events.map((event) => event.kind)).toEqual(['text', 'usage']);
  });

  it('returns the last stopped assistant text and keeps distinct message ids', async () => {
    const replay = replaySpawn([transcript(
      { type: 'message_start', message: { role: 'assistant' } }, assistant('first'),
      { type: 'message_start', message: { role: 'assistant' } }, assistant('tool commentary', { stopReason: 'toolUse' }),
      { type: 'message_start', message: { role: 'assistant' } }, assistant('last'),
    )]);
    const events: AgentEventInput[] = [];
    expect(await turn(createPiAdapter(config(type), replay), { onEvent: (event) => events.push(event) })).toMatchObject({ text: 'last', usage: { inputTokens: 30, outputTokens: 6 }, contextTokens: 12 });
    const texts = events.filter((event) => event.kind === 'text');
    expect(new Set(texts.map((event) => event.messageId)).size).toBe(3);
  });

  it('splits text and thinking, preserves message ids, bounds tool output and ignores partial results', async () => {
    const long = '😀'.repeat(10_000);
    const replay = replaySpawn([transcript(
      { type: 'message_start', message: { role: 'assistant' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: long } },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: long, contentIndex: 1 } },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_end', content: long, contentIndex: 1 } },
      { type: 'tool_execution_start', toolCallId: 'call|suffix', toolName: 'bash', args: { command: 'x'.repeat(500) } },
      { type: 'tool_execution_update', toolCallId: 'call|suffix', partialResult: { content: [{ type: 'text', text: 'partial' }] } },
      { type: 'tool_execution_end', toolCallId: 'call|suffix', result: { content: [{ type: 'text', text: '界'.repeat(3_000) }] }, isError: true },
      assistant(long, { content: [{ type: 'text', text: long }, { type: 'thinking', thinking: long }] }),
    )]);
    const events: AgentEventInput[] = [];
    expect(await turn(createPiAdapter(config(type), replay), { onEvent: (event) => events.push(event) })).toMatchObject({ text: long });
    events.forEach((event, index) => AgentEventSchema.parse({ ...event, seq: index + 1, at: 0 }));
    const messages = events.filter((event) => event.kind === 'text' || event.kind === 'thinking');
    expect(new Set(messages.map((event) => event.messageId)).size).toBe(1);
    expect(events.filter((event) => event.kind === 'thinking').map((event) => event.text).join('')).toBe(long);
    expect(events.filter((event) => event.kind === 'tool_result')).toEqual([{ kind: 'tool_result', id: 'call|suffix', ok: false, output: '界'.repeat(1_365) }]);
  });

  it('emits thinking snapshots only when no deltas were seen', async () => {
    const replay = replaySpawn([transcript(
      { type: 'message_start', message: { role: 'assistant' } },
      { type: 'message_update', assistantMessageEvent: { type: 'thinking_end', content: 'first', contentIndex: 0 } },
      assistant('done', { content: [{ type: 'thinking', thinking: 'first' }, { type: 'thinking', thinking: 'second' }, { type: 'text', text: 'done' }] }),
    )]);
    const events: AgentEventInput[] = [];
    await turn(createPiAdapter(config(type), replay), { onEvent: (event) => events.push(event) });
    expect(events.filter((event) => event.kind === 'thinking').map((event) => event.text)).toEqual(['first', 'second']);
  });

  it.each([
    { stdout: transcript(assistant('usage limit reached')), stderr: '' },
    { stdout: transcript(assistant('normal reply')), stderr: 'rate limit reached' },
    { stdout: transcript(assistant('', { stopReason: 'error', errorMessage: 'HTTP 429' })), stderr: '' },
    { stdout: transcript(
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'rate ' } },
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'limit reached' } },
    ), stderr: '' },
  ])('maps rate limits from assistant text, stderr and failures', async ({ stdout, stderr }) => {
    await expect(turn(createPiAdapter(config(type), replaySpawn([stdout], stderr, 1)))).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('redacts home paths in failure messages and caps them', async () => {
    const home = homedir();
    const stderr = `${home}/.omp/secret.log ${'x'.repeat(3000)}`;
    const error = await turn(createPiAdapter(config(type), replaySpawn([transcript(assistant('partial'))], stderr, 2))).then(
      () => { throw new Error('expected AdapterError'); },
      (value: unknown) => value as AdapterError,
    );
    expect(error).toMatchObject({ code: 'ADAPTER_ERROR' });
    expect(error.message).not.toContain(home);
    expect(error.message).toContain('~/.omp/secret.log');
    expect(error.message.length).toBeLessThanOrEqual(2048);
  });

  it('rejects nonzero exits, unfinished loops, missing sessions and assistant errors', async () => {
    await expect(turn(createPiAdapter(config(type), replaySpawn([transcript(assistant('partial'))], 'diagnostic tail', 2)))).rejects.toMatchObject({ code: 'ADAPTER_ERROR', message: expect.stringContaining('diagnostic tail') });
    await expect(turn(createPiAdapter(config(type), replaySpawn([jsonLines(assistant('partial'))])))).rejects.toMatchObject({ code: 'ADAPTER_ERROR' });
    await expect(turn(createPiAdapter(config(type), replaySpawn([transcript(assistant('tool', { stopReason: 'toolUse' }))])))).rejects.toMatchObject({ code: 'ADAPTER_ERROR' });
    await expect(turn(createPiAdapter(config(type), replaySpawn([transcript(assistant('', { stopReason: 'error', errorMessage: 'provider failed' }))])))).rejects.toMatchObject({ code: 'ADAPTER_ERROR', message: expect.stringContaining('provider failed') });
    if (type === 'omp') await expect(turn(createPiAdapter(config(type), replaySpawn([jsonLines(assistant('done'), { type: 'agent_end' })])))).rejects.toMatchObject({ code: 'ADAPTER_ERROR' });
  });

  it('tolerates malformed JSONL, NUL bytes and unrelated events', async () => {
    const replay = replaySpawn(['garbage\nnull\n42\n[]\n' + transcript(assistant('DONE 3')).replaceAll('\n', '\0\n')]);
    expect(await turn(createPiAdapter(config(type), replay))).toMatchObject({ text: 'DONE 3' });
  });

  it.each(['CANCELLED', 'TIMEOUT'] as const)('maps %s after stopping the child', async (code) => {
    vi.useFakeTimers();
    const child = new ReplayProcess();
    const controller = new AbortController();
    const adapter = createPiAdapter(config(type), { spawnFn: () => child });
    const rejected = expect(turn(adapter, { signal: controller.signal, timeoutMs: 10 })).rejects.toMatchObject({ code });
    if (code === 'CANCELLED') controller.abort();
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('maps native aborted events to CANCELLED', async () => {
    const replay = replaySpawn([transcript(assistant('', { stopReason: 'aborted' }), { type: 'agent_settled', aborted: true })]);
    await expect(turn(createPiAdapter(config(type), replay))).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('registers the adapter lazily without launching a turn', async () => {
    const adapter = await createAdapter(config(type));
    const session = await adapter.createSession({ cwd: '/repo', profile: 'reviewer' });
    if (type === 'pi') expect(session.nativeId).toMatch(/^[0-9a-f-]{36}$/);
    else expect(session.nativeId).toBeNull();
  });
});
