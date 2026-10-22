import { AgentEventSchema } from '@quorum/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKiloAdapter, kiloResetAt, prepareKiloEnvironment } from '../../src/adapters/kilo.js';
import { createAdapter } from '../../src/adapters/index.js';
import { adapterTrust } from '../../src/detect.js';
import type { AgentEventInput, Profile } from '../../src/adapters/types.js';
import { fixture, jsonLines, replaySpawn, turn } from './cli-fixtures.js';

const config = { type: 'kilo', contextWindow: 200_000 } as const;
const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'quorum-kilo-')); dirs.push(dir); return dir; };
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('Kilo CLI adapter', () => {
  it('replays real author, resumed recall, and reviewer captures with valid ordered events', async () => {
    const replay = replaySpawn([fixture('kilo-t1'), fixture('kilo-t2'), fixture('kilo-reviewer')]);
    const adapter = createKiloAdapter(config, { ...replay, homeDir: temp() });
    const events: AgentEventInput[] = [];
    const result = await turn(adapter, { onEvent: (event) => events.push(event) });
    expect(result).toMatchObject({ text: 'DONE 3.', usage: { inputTokens: 6377, outputTokens: 284 } });
    expect(result.nativeId).toBe('ses_e9fa6bc5bffex8G2JEOBUtxmUn');
    expect(events.filter((event) => event.kind === 'tool_call').map((event) => event.toolKind)).toEqual(['read', 'edit', 'write', 'bash']);
    const calls = events.filter((event) => event.kind === 'tool_call');
    const results = events.filter((event) => event.kind === 'tool_result');
    expect(results.map((e) => e.id)).toEqual(calls.map((e) => e.id));
    expect(results.at(-1)).toMatchObject({ ok: true, exitCode: 0, output: '3\n' });
    events.forEach((event, index) => AgentEventSchema.parse({ ...event, seq: index + 1, at: 0 }));
    const resumed = await turn(adapter, { nativeId: result.nativeId });
    expect(resumed).toMatchObject({ nativeId: result.nativeId, text: expect.stringContaining('subtract'), usage: { inputTokens: 169, outputTokens: 21 } });
    const review: AgentEventInput[] = [];
    await turn(adapter, { profile: 'reviewer', onEvent: (event) => review.push(event) });
    expect(review.filter((e) => e.kind === 'tool_call').every((e) => e.toolKind === 'read')).toBe(true);
    expect(review.some((e) => e.kind === 'tool_result' && !e.ok && e.output.includes('pwned.txt'))).toBe(true);
    await adapter.closeSession(result.nativeId);
  });

  it.each<Profile>(['author', 'reviewer', 'directive'])('reasserts %s policy and config isolation on fresh and resumed turns', async (profile) => {
    const homeDir = temp();
    const replay = replaySpawn([fixture('kilo-t2'), fixture('kilo-t2')]);
    const adapter = createKiloAdapter({ ...config, binaryPath: '/custom/kilo', model: 'provider/model' }, { ...replay, homeDir });
    vi.stubEnv('KILO_PERMISSION', '{"*":"allow"}');
    vi.stubEnv('KILO_CONFIG', '/owner/config.json');
    vi.stubEnv('KILO_CONFIG_CONTENT', '{"mcp":{"evil":{}}}');
    vi.stubEnv('KILO_DB', '/owner/kilo.db');
    vi.stubEnv('OPENCODE_CONFIG', '/owner/opencode.json');
    vi.stubEnv('PWD', '/wrong/repo');
    const prompt = '-literal $(touch pwned); {sessionId}';
    await turn(adapter, { profile, prompt });
    await turn(adapter, { nativeId: 'session', profile, prompt });
    for (const [index, call] of replay.calls.entries()) {
      expect(call[0]).toBe('/custom/kilo');
      expect(call[1]).toEqual(['run', '--format', 'json', '--pure', '--agent', 'quorum', '--dir', '/work/repo',
        ...(index === 1 ? ['--session', 'session'] : []), '--model', 'provider/model', '--', prompt]);
      expect(call[2]).toMatchObject({ shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      const env = call[2].env;
      expect(env.HOME).toBe(join(homeDir, profile));
      expect(env.PWD).toBe('/work/repo');
      expect(env.KILO_CONFIG).toBeUndefined();
      expect(env.KILO_DB).toBeUndefined();
      expect(env.OPENCODE_CONFIG).toBeUndefined();
      for (const flag of ['KILO_DISABLE_PROJECT_CONFIG', 'KILO_DISABLE_CLAUDE_CODE', 'KILO_DISABLE_EXTERNAL_SKILLS', 'KILO_DISABLE_DEFAULT_PLUGINS']) expect(env[flag]).toBe('true');
      const permission = JSON.parse(env.KILO_PERMISSION!);
      expect(permission).toEqual({ '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow',
        ...(profile === 'author' ? { edit: 'allow', bash: 'allow' } : {}) });
      const inline = JSON.parse(env.KILO_CONFIG_CONTENT!);
      expect(inline.agent.quorum.permission).toEqual(permission);
      expect(inline).toMatchObject({ instructions: [], mcp: {}, plugin: [], lsp: false, formatter: false });
    }
  });

  it('copies only provider logins; ignores owner instructions, skills, MCP, approval and remote config records', () => {
    const owner = temp();
    mkdirSync(join(owner, '.local/share/kilo'), { recursive: true });
    mkdirSync(join(owner, '.config/kilo'), { recursive: true });
    writeFileSync(join(owner, '.local/share/kilo/auth.json'), JSON.stringify({
      provider: { type: 'api', key: 'secret-provider-key-123' }, org: { type: 'wellknown', url: 'https://evil.example' },
    }));
    for (const file of ['kilo.json', 'AGENTS.md', 'skills']) writeFileSync(join(owner, '.config/kilo', file), 'evil');
    const homeDir = temp();
    const { env, secrets } = prepareKiloEnvironment(homeDir, 'reviewer', '/repo', { HOME: owner, PATH: '/bin' });
    expect(JSON.parse(readFileSync(join(env.XDG_DATA_HOME!, 'kilo/auth.json'), 'utf8'))).toEqual({ provider: { type: 'api', key: 'secret-provider-key-123' } });
    expect(secrets).toContain('secret-provider-key-123');
    expect(readdirSync(env.KILO_CONFIG_DIR!)).toEqual([]);
    expect(existsSync(join(env.HOME!, '.claude'))).toBe(false);
    expect(statSync(env.HOME!).mode & 0o077).toBe(0);
    expect(() => prepareKiloEnvironment(owner, 'reviewer', '/repo', { HOME: owner })).toThrow(/must differ/);
    const author = prepareKiloEnvironment(homeDir, 'author', '/repo', { HOME: owner });
    expect(author.env.XDG_DATA_HOME).not.toBe(env.XDG_DATA_HOME);
  });

  it('requires final completion and maps provider limits with retry and reset times', async () => {
    const error = { name: 'APIError', data: { statusCode: 429, message: 'Too many requests', responseHeaders: { 'retry-after': '60' } } };
    const run = (stdout: string, code = 0) => turn(createKiloAdapter(config, { ...replaySpawn([stdout], '', code), homeDir: temp() }));
    await expect(run(jsonLines({ type: 'error', error }), 1)).rejects.toMatchObject({ code: 'RATE_LIMITED', resetAt: expect.any(Number) });
    expect(kiloResetAt(error, 1000)).toBe(61000);
    expect(kiloResetAt({ resetAt: 1792617000 })).toBe(1792617000000);
    expect(kiloResetAt({ data: { resetsAt: '2026-10-22T01:00:00Z' } })).toBe(Date.parse('2026-10-22T01:00:00Z'));
    expect(kiloResetAt({})).toBeUndefined();
    for (const stdout of ['', 'not JSON\n', jsonLines({ type: 'text', sessionID: 's', part: { id: 'p', text: 'partial' } })]) {
      await expect(run(stdout)).rejects.toMatchObject({ code: 'ADAPTER_ERROR' });
    }
    expect(adapterTrust('kilo')).toBe('low');
    expect(await createAdapter(config, { dataDir: temp() })).toHaveProperty('runTurn');
  });

  it('rejects corrupt owner credentials without exposing their contents', async () => {
    const owner = temp();
    mkdirSync(join(owner, '.local/share/kilo'), { recursive: true });
    writeFileSync(join(owner, '.local/share/kilo/auth.json'), '{"key":"secret-api-key-123456789" bad json');
    vi.stubEnv('HOME', owner);
    vi.stubEnv('XDG_DATA_HOME', join(owner, '.local/share'));
    const replay = replaySpawn([fixture('kilo-t2')]);
    await expect(turn(createKiloAdapter(config, { ...replay, homeDir: temp() }))).rejects.toMatchObject({
      code: 'ADAPTER_ERROR', message: 'Could not read Kilo provider logins; run `kilo auth login`.',
    });
    expect(replay.calls).toHaveLength(0);
  });

  it('redacts credentials before splitting or truncating output and error diagnostics', async () => {
    const secret = 'secret-api-key-123456789';
    vi.stubEnv('TEST_API_KEY', secret);
    const textEvent = { type: 'text', sessionID: 's', part: { id: 'p', text: secret } };
    const complete = { type: 'step_finish', part: { id: 'end', reason: 'stop' } };
    const replay = replaySpawn([jsonLines(textEvent, complete)]);
    const events: AgentEventInput[] = [];
    expect(await turn(createKiloAdapter(config, { ...replay, homeDir: temp() }), { onEvent: (event) => events.push(event) })).toMatchObject({ text: '[redacted]' });
    expect(JSON.stringify(events)).not.toContain(secret);
    await expect(turn(createKiloAdapter(config, { ...replaySpawn(['oops ' + secret], secret, 1), homeDir: temp() }))).rejects.toMatchObject({ message: expect.not.stringContaining(secret) });
  });

  it('deduplicates parts, combines final message parts, and bounds every emitted field', async () => {
    const tool = { type: 'tool_use', sessionID: 's', part: { id: 'tool', callID: 'call', tool: 'edit',
      state: { status: 'error', input: { filePath: 'p'.repeat(2000) }, error: '界'.repeat(3000) } } };
    const usage = { type: 'step_finish', part: { id: 'usage', reason: 'tool-calls', tokens: { input: 10, output: 2, total: 30 } } };
    const text = '😀'.repeat(10000);
    const output = jsonLines(tool, tool, usage, usage,
      { type: 'tool_use', part: { id: 'bash', callID: 'bash', tool: 'bash', state: { status: 'completed', output: 'failed', metadata: { exit: 2 } } } },
      { type: 'text', part: { id: 'comment', messageID: 'old', text: 'commentary' } },
      { type: 'text', part: { id: 't1', messageID: 'final', text } },
      { type: 'text', part: { id: 't2', messageID: 'final', text: 'end' } },
      { type: 'step_finish', part: { id: 'done', reason: 'stop' } });
    const replay = replaySpawn([output]);
    const events: AgentEventInput[] = [];
    expect(await turn(createKiloAdapter(config, { ...replay, homeDir: temp() }), { onEvent: (e) => events.push(e) })).toMatchObject({
      nativeId: 's', text: text + 'end', usage: { inputTokens: 10, outputTokens: 2 }, contextTokens: 30,
    });
    events.forEach((e, i) => AgentEventSchema.parse({ ...e, seq: i + 1, at: 0 }));
    expect(events.filter((e) => e.kind === 'tool_call')).toHaveLength(2);
    expect(events[0]).toMatchObject({ argsSummary: 'p'.repeat(256), paths: ['p'.repeat(1024)] });
    expect(events[1]).toMatchObject({ ok: false, output: '界'.repeat(1365) });
    expect(events.filter((e) => e.kind === 'usage')).toHaveLength(1);
    expect(events.find((e) => e.kind === 'tool_result' && e.exitCode === 2)).toMatchObject({ ok: false, output: 'failed' });
  });
});
