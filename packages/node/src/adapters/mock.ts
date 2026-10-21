import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { AgentEventSchema, type AdapterConfig } from '@quorum/protocol';
import { AdapterError, type AgentAdapter, type Profile, type TurnResult } from './types.js';
import { splitText } from './event-utils.js';

const FailureSchema = z.enum(['RATE_LIMITED', 'ADAPTER_ERROR', 'INVALID_OUTPUT']);
const TokenCountsSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
});

const MockTurnSchema = z.object({
  writeFiles: z.record(z.string(), z.string()).optional(),
  reply: z.unknown().optional(),
  rawReply: z.string().optional(),
  failTurnWith: FailureSchema.nullable().optional(),
  delayMs: z.number().int().nonnegative().optional(),
  tokensPerTurn: TokenCountsSchema.optional(),
  events: z.array(z.preprocess(
    (value) => value !== null && typeof value === 'object' ? { ...value, seq: 1, at: 0 } : value,
    AgentEventSchema,
  ).transform(({ seq: _seq, at: _at, ...event }) => event)).optional(),
});

const MockRuleSchema = z.object({
  match: z.object({
    taskTitleContains: z.string().min(1).optional(),
    any: z.boolean().optional(),
  }),
  turns: z.array(MockTurnSchema).min(1),
});

const MockScriptSchema = z.object({
  author: z.array(MockRuleSchema).optional(),
  reviewer: z.array(MockRuleSchema).optional(),
  directive: z.array(MockRuleSchema).optional(),
  behaviors: z.object({
    failTurnWith: FailureSchema.nullable().optional(),
    delayMs: z.number().int().nonnegative().optional(),
    tokensPerTurn: TokenCountsSchema.optional(),
  }).optional(),
});

type MockScript = z.infer<typeof MockScriptSchema>;
type MockTurn = z.infer<typeof MockTurnSchema>;
type MockAdapterConfig = Extract<AdapterConfig, { type: 'mock' }>;

interface MockSession {
  nativeId: string;
  sid: string;
  cwd: string;
  profile: Profile;
  contextTokens: number;
}

type PromptIdentity =
  | { kind: 'task'; id: string; title: string }
  | { kind: 'directive'; id: string }
  | { kind: 'internal'; marker: string };

export async function createMockAdapter(config: MockAdapterConfig): Promise<AgentAdapter> {
  const scriptPath = resolve(config.scriptPath);
  const scriptText = await readFile(scriptPath, 'utf8');
  let json: unknown;
  try {
    json = JSON.parse(scriptText) as unknown;
  } catch (error) {
    throw new Error(`Invalid mock script JSON at ${scriptPath}: ${errorMessage(error)}`, { cause: error });
  }
  const script = MockScriptSchema.parse(json);

  const sessions = new Map<string, MockSession>();
  const turnIndexes = new Map<string, number>();

  return {
    createSession: async ({ cwd, profile }) => {
      const canonicalCwd = await realpath(cwd);
      const nativeId = `mock-${randomUUID()}`;
      const session: MockSession = {
        nativeId,
        sid: basename(canonicalCwd),
        cwd: canonicalCwd,
        profile,
        contextTokens: 0,
      };
      sessions.set(nativeId, session);
      return { nativeId };
    },

    runTurn: async (opts) => {
      const session = opts.nativeId === null
        ? await createLazySession(opts.cwd, opts.profile, sessions)
        : sessions.get(opts.nativeId);
      if (session === undefined) {
        throw new AdapterError('ADAPTER_ERROR', `Unknown mock session: ${opts.nativeId}`);
      }
      if (session.profile !== opts.profile) {
        throw new AdapterError('ADAPTER_ERROR', `Mock session ${session.nativeId} profile changed from ${session.profile} to ${opts.profile}`);
      }
      const canonicalCwd = await realpath(opts.cwd);
      if (canonicalCwd !== session.cwd) {
        throw new AdapterError('ADAPTER_ERROR', `Mock session ${session.nativeId} changed worktree`);
      }

      const identity = parsePromptIdentity(opts.prompt);
      if (identity.kind === 'internal') {
        opts.onEvent?.({ kind: 'status', text: 'Mock turn started' });
        const counts = resolveInternalTurnCounts(script, opts.prompt);
        await waitForTurn(script.behaviors?.delayMs ?? 0, opts.timeoutMs, opts.signal);
        const reply = identity.marker === 'QUORUM-SUMMARIZE'
          ? { summary: 'mock summary' }
          : { summary: 'mock session seeded' };
        const result = finishTurn(session, reply, counts);
        for (const text of splitText(result.text)) opts.onEvent?.({ kind: 'text', mode: 'final', text });
        return result;
      }

      const rule = findRule(script[opts.profile] ?? [], identity);
      if (rule === undefined) {
        throw new AdapterError('ADAPTER_ERROR', `No mock ${opts.profile} rule matches ${describeIdentity(identity)}`);
      }
      const turn = nextTurn(rule, identity, session.sid, turnIndexes);
      if (turn.events === undefined) opts.onEvent?.({ kind: 'status', text: 'Mock turn started' });
      const counts = resolveTurnCounts(script, turn, opts.prompt);
      const delayMs = turn.delayMs ?? script.behaviors?.delayMs ?? 0;
      await waitForTurn(delayMs, opts.timeoutMs, opts.signal);
      const failTurnWith = turn.failTurnWith === undefined
        ? script.behaviors?.failTurnWith
        : turn.failTurnWith;
      if (turn.events !== undefined) {
        for (const event of turn.events) opts.onEvent?.(event);
      }

      if (failTurnWith === 'RATE_LIMITED') throw new AdapterError('RATE_LIMITED');
      if (failTurnWith === 'ADAPTER_ERROR') throw new AdapterError('ADAPTER_ERROR');

      if (turn.writeFiles !== undefined) {
        for (const [index, [path, contents]] of Object.entries(turn.writeFiles).entries()) {
          const id = `mock-write-${index + 1}`;
          if (turn.events === undefined) opts.onEvent?.({ kind: 'tool_call', id, name: 'Write', toolKind: 'write', argsSummary: path.slice(0, 256), paths: [path.slice(0, 1024)] });
          await writeFilesInsideWorktree(session.cwd, { [path]: contents });
          if (turn.events === undefined) opts.onEvent?.({ kind: 'tool_result', id, ok: true, output: `Wrote ${path}`.slice(0, 1024) });
        }
      }
      const output = failTurnWith === 'INVALID_OUTPUT'
        ? turn.rawReply ?? 'mock invalid output'
        : turn.rawReply ?? encodeReply(turn.reply === undefined ? defaultReply(opts.profile) : turn.reply);
      const result = finishTurn(session, output, counts, true);
      if (turn.events === undefined) {
        for (const text of splitText(result.text)) opts.onEvent?.({ kind: 'text', mode: 'final', text });
      }
      return result;
    },

    closeSession: async (nativeId) => {
      sessions.delete(nativeId);
    },
  };
}

async function createLazySession(
  cwd: string,
  profile: Profile,
  sessions: Map<string, MockSession>,
): Promise<MockSession> {
  const canonicalCwd = await realpath(cwd);
  const nativeId = `mock-${randomUUID()}`;
  const session: MockSession = {
    nativeId,
    sid: basename(canonicalCwd),
    cwd: canonicalCwd,
    profile,
    contextTokens: 0,
  };
  sessions.set(nativeId, session);
  return session;
}

function parsePromptIdentity(prompt: string): PromptIdentity {
  const lines = prompt.split(/\r?\n/);
  const first = lines[0] ?? '';
  for (const marker of ['QUORUM-SUMMARIZE', 'QUORUM-SEED']) {
    if (first === marker || (lines[1] === '' && lines[2] === marker)) {
      return { kind: 'internal', marker };
    }
  }

  const task = /^QUORUM-TASK:\s+(\S+)(?:\s+(.*))?$/.exec(first);
  if (task !== null) return { kind: 'task', id: task[1]!, title: task[2] ?? '' };

  const directive = /^QUORUM-DIRECTIVE:\s+(.+)$/.exec(first);
  if (directive !== null) return { kind: 'directive', id: directive[1]! };

  throw new AdapterError('ADAPTER_ERROR', 'Mock prompt must start with a Quorum task, directive, summarize, or seed marker.');
}

function findRule(rules: readonly z.infer<typeof MockRuleSchema>[], identity: Exclude<PromptIdentity, { kind: 'internal' }>) {
  if (identity.kind === 'task') {
    const title = identity.title.toLocaleLowerCase();
    const specific = rules.find((rule) => {
      const fragment = rule.match.taskTitleContains;
      return fragment !== undefined && title.includes(fragment.toLocaleLowerCase());
    });
    if (specific !== undefined) return specific;
  }
  return rules.find((rule) => rule.match.any === true);
}

function nextTurn(
  rule: z.infer<typeof MockRuleSchema>,
  identity: Exclude<PromptIdentity, { kind: 'internal' }>,
  sid: string,
  turnIndexes: Map<string, number>,
): MockTurn {
  const key = `${sid}\0${identity.kind}\0${identity.id}`;
  const index = turnIndexes.get(key) ?? 0;
  turnIndexes.set(key, index + 1);
  return rule.turns[Math.min(index, rule.turns.length - 1)]!;
}

function resolveTurnCounts(
  script: MockScript,
  turn: MockTurn,
  prompt: string,
): { inputTokens: number; outputTokens?: number } {
  const counts = turn.tokensPerTurn ?? script.behaviors?.tokensPerTurn;
  if (counts !== undefined) return { inputTokens: counts.input, outputTokens: counts.output };
  return { inputTokens: estimateTokens(prompt) };
}

function resolveInternalTurnCounts(
  script: MockScript,
  prompt: string,
): { inputTokens: number; outputTokens?: number } {
  const counts = script.behaviors?.tokensPerTurn;
  if (counts !== undefined) return { inputTokens: counts.input, outputTokens: counts.output };
  return { inputTokens: estimateTokens(prompt) };
}

function finishTurn(
  session: MockSession,
  output: unknown,
  counts: { inputTokens: number; outputTokens?: number },
  alreadyEncoded = false,
): TurnResult & { nativeId: string } {
  const text = alreadyEncoded && typeof output === 'string' ? output : encodeReply(output);
  session.contextTokens += counts.inputTokens;
  return {
    nativeId: session.nativeId,
    text,
    usage: { inputTokens: counts.inputTokens, outputTokens: counts.outputTokens ?? estimateTokens(text) },
    contextTokens: session.contextTokens,
  };
}

function defaultReply(profile: Profile): unknown {
  switch (profile) {
    case 'author':
      return { status: 'done', summary: 'mock task completed' };
    case 'reviewer':
      return { verdict: 'approve', summary: 'mock review approved', previousIssues: [], newIssues: [] };
    case 'directive':
      return { answer: 'mock directive completed' };
  }
}

function encodeReply(reply: unknown): string {
  return `\`\`\`quorum-json\n${JSON.stringify(reply)}\n\`\`\``;
}

async function writeFilesInsideWorktree(cwd: string, files: Record<string, string>): Promise<void> {
  const root = await realpath(cwd);
  for (const [filePath, contents] of Object.entries(files)) {
    if (filePath.length === 0 || isAbsolute(filePath)) {
      throw new AdapterError('ADAPTER_ERROR', `Mock write path must be relative: ${filePath}`);
    }
    const target = resolve(root, filePath);
    const relativeTarget = relative(root, target);
    if (relativeTarget.length === 0 || relativeTarget === '..' || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
      throw new AdapterError('ADAPTER_ERROR', `Mock write path escapes the worktree: ${filePath}`);
    }

    const segments = relativeTarget.split(sep);
    let parent = root;
    for (const segment of segments.slice(0, -1)) {
      parent = join(parent, segment);
      try {
        const info = await lstat(parent);
        if (info.isSymbolicLink() || !info.isDirectory()) {
          throw new AdapterError('ADAPTER_ERROR', `Mock write path traverses a non-directory: ${filePath}`);
        }
      } catch (error) {
        if (!isNotFound(error)) throw error;
        await mkdir(parent);
      }
    }

    try {
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new AdapterError('ADAPTER_ERROR', `Mock write target is not a regular file: ${filePath}`);
      }
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    await writeFile(target, contents, 'utf8');
  }
}

async function waitForTurn(delayMs: number, timeoutMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new AdapterError('CANCELLED', 'Mock turn was cancelled.');
  await new Promise<void>((resolvePromise, reject) => {
    let settled = false;
    const delayTimer = setTimeout(() => finish(resolvePromise), delayMs);
    const timeoutTimer = setTimeout(
      () => finish(() => reject(new AdapterError('TIMEOUT', 'Mock turn timed out.'))),
      timeoutMs,
    );
    const onAbort = () => finish(() => reject(new AdapterError('CANCELLED', 'Mock turn was cancelled.')));
    function finish(callback: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(delayTimer);
      clearTimeout(timeoutTimer);
      signal.removeEventListener('abort', onAbort);
      callback();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function describeIdentity(identity: Exclude<PromptIdentity, { kind: 'internal' }>): string {
  return identity.kind === 'task'
    ? `task ${identity.id} (${identity.title})`
    : `directive ${identity.id}`;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
