import { AgentEventSchema, CustomAdapterConfigSchema } from '@quorum/protocol';
import { describe, expect, it } from 'vitest';
import { createCustomAdapter, jsonField } from '../../src/adapters/custom.js';
import { createAdapter } from '../../src/adapters/index.js';
import { adapterTrust } from '../../src/detect.js';
import type { AgentEventInput, Profile } from '../../src/adapters/types.js';
import { jsonLines, replaySpawn, turn } from './cli-fixtures.js';

const command = (profile: string) => ({ command: '/bin/agent', args: ['--json', `--${profile}`, '--', '{prompt}'],
  resume: { command: '/bin/agent-resume', args: [`--${profile}`, '--session', '{sessionId}', '--', '{prompt}'] } });
const config = CustomAdapterConfigSchema.parse({
  type: 'custom', profiles: { author: command('write'), reviewer: command('read-only'), directive: command('read-only') },
  sessionIdPath: 'meta.session', eventTypePath: 'event.name',
  mapping: {
    text: { event: 'say', text: 'payload.text', messageId: 'payload.id' },
    tool_call: { event: 'call', id: 'payload.id', name: 'payload.tool', argsSummary: 'payload.summary' },
    tool_result: { event: 'result', id: 'payload.id', output: 'payload.output', ok: 'payload.ok', exitCode: 'payload.exit' },
    usage: { event: 'tokens', inputTokens: 'payload.in', outputTokens: 'payload.out', contextTokens: 'payload.context' },
    turn_end: { event: 'done' },
  },
});
const event = (name: string, payload: unknown = {}) => ({ event: { name }, payload });
const stream = (...events: unknown[]) => jsonLines({ meta: { session: 's-1' } }, ...events, event('done'));
const reply = event('say', { text: 'done', id: 'm-1' });

describe('custom CLI adapter', () => {
  it('maps nested JSONL fields, namespaces tools, bounds output, and reports usage', async () => {
    const replay = replaySpawn([stream(
      event('call', { id: 'c1', tool: 'bash', summary: 'node test.js' }),
      event('result', { id: 'c1', ok: false, output: '界'.repeat(3000), exit: 1 }),
      event('tokens', { in: 10, out: 4, context: 30 }),
      event('tokens', { in: 20, out: 5, context: 50 }), reply,
    )]);
    const events: AgentEventInput[] = [];
    const result = await turn(createCustomAdapter(config, replay), { onEvent: (event) => events.push(event) });
    expect(result).toEqual({ nativeId: 's-1', text: 'done', usage: { inputTokens: 30, outputTokens: 9 }, contextTokens: 50 });
    expect(events.map((e) => e.kind)).toEqual(['tool_call', 'tool_result', 'usage', 'usage', 'text']);
    events.forEach((event, index) => AgentEventSchema.parse({ ...event, seq: index + 1, at: 0 }));
    expect(events[0]).toMatchObject({ toolKind: 'bash', argsSummary: 'node test.js' });
    expect(events[1]).toMatchObject({ id: 'id' in events[0]! ? events[0].id : '', ok: false, exitCode: 1, output: '界'.repeat(1365) });
    expect(adapterTrust('custom')).toBe('low');
    expect(await createAdapter(config)).toHaveProperty('runTurn');
  });

  it.each<Profile>(['author', 'reviewer', 'directive'])('uses the %s template on fresh and resumed turns without shell substitution', async (profile) => {
    const replay = replaySpawn([stream(reply), stream(reply)]);
    const adapter = createCustomAdapter(config, replay);
    const prompt = '-literal $(touch pwned); $& {sessionId}';
    await turn(adapter, { profile, prompt });
    await turn(adapter, { nativeId: 's-1', profile, prompt });
    const flag = profile === 'author' ? '--write' : '--read-only';
    expect(replay.calls[0]![0]).toBe('/bin/agent');
    expect(replay.calls[0]![1]).toEqual(['--json', flag, '--', prompt]);
    expect(replay.calls[1]![0]).toBe('/bin/agent-resume');
    expect(replay.calls[1]![1]).toEqual([flag, '--session', 's-1', '--', prompt]);
    for (const call of replay.calls) expect(call[2]).toMatchObject({ shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  });

  it('uses base argv when resume is absent and supports text deltas and array paths', async () => {
    const deltaConfig = CustomAdapterConfigSchema.parse({ ...config,
      profiles: { ...config.profiles, author: { command: 'agent', args: ['{sessionId}', '{prompt}'] } },
      mapping: { ...config.mapping, text: { event: 'say', text: 'payload.0.text', mode: 'delta' } },
    });
    const replay = replaySpawn([stream(event('say', [{ text: 'one ' }]), event('say', [{ text: 'two' }]))]);
    expect(await turn(createCustomAdapter(deltaConfig, replay), { nativeId: 'resume' })).toMatchObject({ text: 'one two' });
    expect(replay.calls[0]![1]).toEqual(['resume', 'do it']);
    expect(jsonField({}, '__proto__.polluted')).toBeUndefined();
    expect(jsonField(null, 'a.b')).toBeUndefined();
  });

  it('keeps only the last assistant message when delta streams include message ids', async () => {
    const deltaConfig = CustomAdapterConfigSchema.parse({ ...config, mapping: {
      ...config.mapping, text: { ...config.mapping.text, mode: 'delta' },
    } });
    const replay = replaySpawn([stream(
      event('say', { text: 'commentary', id: 'old' }),
      event('say', { text: 'final ', id: 'new' }), event('say', { text: 'reply', id: 'new' }),
    )]);
    expect(await turn(createCustomAdapter(deltaConfig, replay))).toMatchObject({ text: 'final reply' });
  });

  it('rejects absent profiles, incomplete output, bad counters, and failed commands', async () => {
    expect(CustomAdapterConfigSchema.safeParse({ ...config, profiles: { author: command('write') } }).success).toBe(false);
    for (const stdout of [jsonLines(reply), stream(), jsonLines(event('done')), 'garbage\n']) {
      await expect(turn(createCustomAdapter(config, replaySpawn([stdout])))).rejects.toMatchObject({ code: 'ADAPTER_ERROR' });
    }
    await expect(turn(createCustomAdapter(config, replaySpawn([stream(reply)], 'HTTP 429', 1)))).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    const events: AgentEventInput[] = [];
    await turn(createCustomAdapter(config, replaySpawn([stream(event('tokens', { in: -1, out: '5' }), reply)])), { onEvent: (e) => events.push(e) });
    expect(events.map((e) => e.kind)).toEqual(['text']);
  });
});
