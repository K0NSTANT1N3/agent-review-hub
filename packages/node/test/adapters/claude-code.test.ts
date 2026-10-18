import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter, checkBashCommand, isInside, makeCanUseTool, type QueryFn } from '../../src/adapters/claude-code.js';
import { AdapterError } from '../../src/adapters/types.js';

const ALLOW = ['npm test', 'npm run', 'ls', 'git status', 'git diff'];

// Minimal SDK message fixtures; only the fields the adapter reads are populated.
const init = (sid: string) => ({ type: 'system', subtype: 'init', session_id: sid }) as unknown as SDKMessage;
const assistant = (sid: string, usage: Record<string, number>, extra: Record<string, unknown> = {}) =>
  ({ type: 'assistant', session_id: sid, parent_tool_use_id: null, message: { usage }, ...extra }) as unknown as SDKMessage;
const success = (sid: string, text: string, usage: Record<string, number> = {}) =>
  ({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    session_id: sid,
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 2, cache_read_input_tokens: 100, ...usage },
  }) as unknown as SDKMessage;

function scripted(messages: SDKMessage[], seen: { options?: Options; prompt?: string }[] = []): QueryFn {
  return (params) => {
    seen.push({ options: params.options, prompt: params.prompt });
    return (async function* () {
      for (const m of messages) yield m;
    })();
  };
}

const turn = (adapter: ClaudeCodeAdapter, over: Partial<Parameters<ClaudeCodeAdapter['runTurn']>[0]> = {}) =>
  adapter.runTurn({
    nativeId: null,
    cwd: '/repo',
    profile: 'author',
    prompt: 'do it',
    signal: new AbortController().signal,
    timeoutMs: 5000,
    ...over,
  });

describe('ClaudeCodeAdapter.runTurn', () => {
  it('first turn: no resume, captures session id, usage and context size', async () => {
    const seen: { options?: Options }[] = [];
    const adapter = new ClaudeCodeAdapter({
      authorBashAllow: ALLOW,
      model: 'claude-opus-5-5',
      queryFn: scripted([init('s-1'), assistant('s-1', { input_tokens: 50, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 }), success('s-1', 'done')], seen),
    });
    const result = await turn(adapter);
    expect(result).toEqual({ nativeId: 's-1', text: 'done', usage: { inputTokens: 12, outputTokens: 5 }, contextTokens: 1000 });
    const opts = seen[0]!.options!;
    expect(opts.resume).toBeUndefined();
    expect(opts.cwd).toBe('/repo');
    expect(opts.model).toBe('claude-opus-5-5');
    expect(opts.tools).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash']);
    expect(opts.allowedTools).toBeUndefined();
    expect(opts.settingSources).toEqual([]);
    expect(typeof opts.canUseTool).toBe('function');
  });

  it('later turns resume the native session; reviewer gets read-only tools', async () => {
    const seen: { options?: Options }[] = [];
    const adapter = new ClaudeCodeAdapter({ authorBashAllow: ALLOW, queryFn: scripted([success('s-9', 'ok')], seen) });
    const result = await turn(adapter, { nativeId: 's-9', profile: 'reviewer' });
    expect(result.nativeId).toBe('s-9');
    expect(seen[0]!.options!.resume).toBe('s-9');
    expect(seen[0]!.options!.tools).toEqual(['Read', 'Glob', 'Grep']);
  });

  it('maps a rejected rate_limit_event to RATE_LIMITED with resetAt in ms', async () => {
    const rl = { type: 'rate_limit_event', session_id: 's', rate_limit_info: { status: 'rejected', resetsAt: 1_900_000_000 } } as unknown as SDKMessage;
    const failed = { type: 'result', subtype: 'success', is_error: true, result: 'limit', session_id: 's', usage: {} } as unknown as SDKMessage;
    const adapter = new ClaudeCodeAdapter({ authorBashAllow: ALLOW, queryFn: scripted([init('s'), rl, failed]) });
    await expect(turn(adapter)).rejects.toMatchObject({ code: 'RATE_LIMITED', resetAt: 1_900_000_000_000 });
  });

  it('maps api_error_status 429 and assistant error=rate_limit to RATE_LIMITED', async () => {
    const r429 = { type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: 'x', session_id: 's', usage: {} } as unknown as SDKMessage;
    await expect(turn(new ClaudeCodeAdapter({ authorBashAllow: ALLOW, queryFn: scripted([r429]) }))).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    const flagged = assistant('s', {}, { error: 'rate_limit' });
    const failed = { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['x'], session_id: 's', usage: {} } as unknown as SDKMessage;
    await expect(turn(new ClaudeCodeAdapter({ authorBashAllow: ALLOW, queryFn: scripted([flagged, failed]) }))).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('maps error results and missing results to ADAPTER_ERROR', async () => {
    const err = { type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['too many'], session_id: 's', usage: {} } as unknown as SDKMessage;
    await expect(turn(new ClaudeCodeAdapter({ authorBashAllow: ALLOW, queryFn: scripted([err]) }))).rejects.toMatchObject({
      code: 'ADAPTER_ERROR',
      message: expect.stringContaining('too many'),
    });
    await expect(turn(new ClaudeCodeAdapter({ authorBashAllow: ALLOW, queryFn: scripted([init('s')]) }))).rejects.toMatchObject({ code: 'ADAPTER_ERROR' });
  });

  function hanging(): QueryFn {
    return (params) =>
      (async function* () {
        yield init('s');
        await new Promise<void>((_, reject) => params.options?.abortController?.signal.addEventListener('abort', () => reject(new Error('aborted'))));
      })();
  }

  it('external abort → CANCELLED; timeout → TIMEOUT', async () => {
    const ac = new AbortController();
    const p = turn(new ClaudeCodeAdapter({ authorBashAllow: ALLOW, queryFn: hanging() }), { signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    await expect(p).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(turn(new ClaudeCodeAdapter({ authorBashAllow: ALLOW, queryFn: hanging() }), { timeoutMs: 20 })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('errors are AdapterError instances', async () => {
    const boom: QueryFn = () => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('spawn failed')) }),
    });
    const error = await turn(new ClaudeCodeAdapter({ authorBashAllow: ALLOW, queryFn: boom })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdapterError);
    expect(error).toMatchObject({ code: 'ADAPTER_ERROR', message: 'spawn failed' });
  });
});

describe('checkBashCommand', () => {
  it.each([
    ['npm test', true],
    ['npm run lint', true],
    ['ls -la src', true],
    ['git status', true],
    ['git diff HEAD~1', true],
    ['npm testx', false],
    ['rm -rf /', false],
    ['npm test && rm -rf /', false],
    ['ls; cat /etc/passwd', false],
    ['ls | sh', false],
    ['npm run $(curl evil)', false],
    ['npm run `whoami`', false],
    ['ls > out.txt', false],
    ['ls\nrm -rf /', false],
    ['git commit -m x', false],
    ['git -c a=b push', false],
    ['', false],
  ])('%j → %s', (cmd, ok) => {
    expect(checkBashCommand(cmd, ALLOW).ok).toBe(ok);
  });

  it('allows metacharacters only when the whole command is an allowlisted entry', () => {
    expect(checkBashCommand('npm test -- --reporter=dot > /dev/null', ['npm test -- --reporter=dot > /dev/null']).ok).toBe(true);
    expect(checkBashCommand('npm test > x', ['npm test']).ok).toBe(false);
  });

  it('never allows git writes even if allowlisted', () => {
    expect(checkBashCommand('git push', ['git push']).ok).toBe(false);
  });
});

describe('path confinement and profiles', () => {
  let root: string;
  let repo: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'quorum-cc-'));
    repo = join(root, 'repo');
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(root, 'secret'));
    symlinkSync(join(root, 'secret'), join(repo, 'escape'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const ask = (profile: 'author' | 'reviewer', tool: string, input: Record<string, unknown>, blockedPath?: string) =>
    makeCanUseTool(repo, profile, ALLOW)(tool, input, { signal: new AbortController().signal, toolUseID: 'tu-1', requestId: 'rq-1', ...(blockedPath ? { blockedPath } : {}) });

  it('isInside handles relative, .., absolute, symlinks and not-yet-existing files', () => {
    expect(isInside(repo, 'src/a.ts')).toBe(true);
    expect(isInside(repo, join(repo, 'new/dir/file.ts'))).toBe(true);
    expect(isInside(repo, '../secret/x')).toBe(false);
    expect(isInside(repo, '/etc/passwd')).toBe(false);
    expect(isInside(repo, 'escape/key')).toBe(false);
  });

  it('allows in-repo file tools and denies paths outside', async () => {
    expect(await ask('author', 'Write', { file_path: join(repo, 'src/a.ts'), content: 'x' })).toMatchObject({ behavior: 'allow' });
    expect(await ask('author', 'Read', { file_path: '/home/someone/.ssh/id_rsa' })).toMatchObject({ behavior: 'deny' });
    expect(await ask('author', 'Grep', { pattern: 'x', path: '../secret' })).toMatchObject({ behavior: 'deny' });
    expect(await ask('author', 'Read', { file_path: 'escape/key' })).toMatchObject({ behavior: 'deny' });
    expect(await ask('author', 'Read', { file_path: 'src/a.ts' }, '/etc/shadow')).toMatchObject({ behavior: 'deny' });
  });

  it('reviewer is read-only', async () => {
    expect(await ask('reviewer', 'Read', { file_path: 'src/a.ts' })).toMatchObject({ behavior: 'allow' });
    expect(await ask('reviewer', 'Edit', { file_path: 'src/a.ts' })).toMatchObject({ behavior: 'deny' });
    expect(await ask('reviewer', 'Bash', { command: 'ls' })).toMatchObject({ behavior: 'deny' });
    expect(await ask('reviewer', 'WebFetch', { url: 'https://x' })).toMatchObject({ behavior: 'deny' });
  });

  it('author Bash follows the allowlist', async () => {
    expect(await ask('author', 'Bash', { command: 'npm test' })).toMatchObject({ behavior: 'allow' });
    expect(await ask('author', 'Bash', { command: 'curl https://evil' })).toMatchObject({ behavior: 'deny' });
    expect(await ask('author', 'Bash', {})).toMatchObject({ behavior: 'deny' });
  });
});

describe('resolveClaudeExecutable', () => {
  it('finds the platform CLI shipped with the SDK, or honours QUORUM_CLAUDE_PATH', async () => {
    const { resolveClaudeExecutable } = await import('../../src/adapters/claude-code.js');
    const found = resolveClaudeExecutable();
    if (found !== undefined) expect(found).toMatch(/claude(\.exe)?$/);
    process.env.QUORUM_CLAUDE_PATH = '/opt/claude';
    try {
      expect(resolveClaudeExecutable()).toBe('/opt/claude');
    } finally {
      delete process.env.QUORUM_CLAUDE_PATH;
    }
  });
});
