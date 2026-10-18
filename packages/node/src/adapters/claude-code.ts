import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { CanUseTool, Options, PermissionResult, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { AdapterError, type AgentAdapter, type Profile, type TurnResult } from './types.js';

// Spec §15.2. Owned by Claude (see tasks/*.md §2).

export type QueryFn = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;

export interface ClaudeCodeAdapterOptions {
  model?: string;
  /** NodeConfig.authorBashAllow — command prefixes the author profile may run. */
  authorBashAllow: readonly string[];
  /** Injected in tests; defaults to the SDK's query(). */
  queryFn?: QueryFn;
}

const PROFILE_TOOLS: Record<Profile, readonly string[]> = {
  author: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
  reviewer: ['Read', 'Glob', 'Grep'],
  directive: ['Read', 'Glob', 'Grep'],
};

const PATH_FIELDS = ['file_path', 'path', 'notebook_path'] as const;
const SHELL_METACHARS = [';', '&&', '||', '|', '`', '$(', '>', '<', '\n', '\r'];
const FORBIDDEN_GIT = /\bgit\s+(?:-[^\s]+\s+)*(commit|push|checkout|switch|merge|rebase|reset|restore|clean|stash|worktree|branch|tag|remote|config|filter-branch|update-ref)\b/;

/** Resolves symlinks where possible so `cwd/../x` and symlink escapes are caught. */
function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // Not created yet (e.g. a Write target): canonicalise the closest existing parent.
    const parent = resolve(p, '..');
    return parent === p ? p : resolve(canonical(parent), relative(parent, p));
  }
}

export function isInside(root: string, target: string): boolean {
  const r = canonical(root);
  const t = canonical(isAbsolute(target) ? target : resolve(root, target));
  const rel = relative(r, t);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
}

/** Pure Bash policy (spec §15.2 b, c). Exported for tests. */
export function checkBashCommand(command: string, allow: readonly string[]): { ok: true } | { ok: false; reason: string } {
  const cmd = command.trim();
  if (cmd === '') return { ok: false, reason: 'empty command' };
  if (FORBIDDEN_GIT.test(cmd)) return { ok: false, reason: 'git write operations are performed by Quorum, not the agent' };
  const exact = allow.some((entry) => cmd === entry.trim());
  if (!exact && SHELL_METACHARS.some((m) => cmd.includes(m))) {
    return { ok: false, reason: 'shell operators are not allowed; run one allowlisted command at a time' };
  }
  const prefixed = allow.some((entry) => {
    const e = entry.trim();
    return e !== '' && (cmd === e || cmd.startsWith(`${e} `));
  });
  return prefixed ? { ok: true } : { ok: false, reason: `command not in the allowlist: ${allow.join(', ')}` };
}

/** Builds the canUseTool callback enforcing spec §15.2 for one turn. Exported for tests. */
export function makeCanUseTool(cwd: string, profile: Profile, authorBashAllow: readonly string[]): CanUseTool {
  const allowed = new Set(PROFILE_TOOLS[profile]);
  const deny = (message: string): PermissionResult => ({ behavior: 'deny', message });
  return async (toolName, input, { blockedPath }) => {
    if (!allowed.has(toolName)) return deny(`${toolName} is not available to the ${profile} profile`);
    if (blockedPath !== undefined && !isInside(cwd, blockedPath)) return deny(`access outside the repository is not allowed: ${blockedPath}`);
    for (const field of PATH_FIELDS) {
      const value = input[field];
      if (typeof value === 'string' && value !== '' && !isInside(cwd, value)) {
        return deny(`access outside the repository is not allowed: ${value}`);
      }
    }
    if (toolName === 'Bash') {
      const command = input.command;
      if (typeof command !== 'string') return deny('Bash requires a command string');
      const verdict = checkBashCommand(command, authorBashAllow);
      if (!verdict.ok) return deny(verdict.reason);
    }
    return { behavior: 'allow', updatedInput: input };
  };
}

/** `resetsAt` may be seconds or milliseconds depending on the producer. */
function toMillis(ts: number | undefined): number | undefined {
  if (ts === undefined || !Number.isFinite(ts)) return undefined;
  return ts < 1e12 ? ts * 1000 : ts;
}

interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

const n = (v: number | null | undefined): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Context size seen by the last model call: every input token, cached or not. */
function contextOf(u: UsageLike): number {
  return n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens);
}

export class ClaudeCodeAdapter implements AgentAdapter {
  private readonly queryFn: QueryFn;

  constructor(private readonly options: ClaudeCodeAdapterOptions) {
    this.queryFn = options.queryFn ?? defaultQuery;
  }

  // Claude Code creates sessions lazily; the id arrives with the first turn's init message.
  async createSession(_opts: { cwd: string; profile: Profile }): Promise<{ nativeId: string | null }> {
    return { nativeId: null };
  }

  // Sessions are transcript files owned by Claude Code; nothing to release.
  async closeSession(_nativeId: string): Promise<void> {}

  async runTurn(opts: {
    nativeId: string | null;
    cwd: string;
    profile: Profile;
    prompt: string;
    signal: AbortSignal;
    timeoutMs: number;
  }): Promise<TurnResult & { nativeId: string }> {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    if (opts.signal.aborted) throw new AdapterError('CANCELLED', 'turn cancelled before start');
    opts.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, opts.timeoutMs);

    const options: Options = {
      cwd: opts.cwd,
      tools: [...PROFILE_TOOLS[opts.profile]],
      // No allowedTools: those bypass canUseTool, which must see every call.
      canUseTool: makeCanUseTool(opts.cwd, opts.profile, this.options.authorBashAllow),
      permissionMode: 'default',
      // Isolation: the owner's personal settings/hooks must not widen these permissions.
      settingSources: [],
      abortController: controller,
      ...(this.options.model !== undefined ? { model: this.options.model } : {}),
      ...(opts.nativeId !== null ? { resume: opts.nativeId } : {}),
    };

    let sessionId = opts.nativeId;
    let contextTokens = 0;
    let rateLimitedUntil: number | undefined;
    let rateLimited = false;
    try {
      for await (const msg of this.queryFn({ prompt: opts.prompt, options })) {
        if (msg.session_id) sessionId = msg.session_id;
        if (msg.type === 'assistant') {
          if (msg.parent_tool_use_id === null && msg.message.usage) contextTokens = contextOf(msg.message.usage);
          if (msg.error === 'rate_limit') rateLimited = true;
        } else if (msg.type === 'rate_limit_event' && msg.rate_limit_info.status === 'rejected') {
          rateLimited = true;
          rateLimitedUntil = toMillis(msg.rate_limit_info.resetsAt);
        } else if (msg.type === 'result') {
          const usage = { inputTokens: n(msg.usage.input_tokens) + n(msg.usage.cache_creation_input_tokens), outputTokens: n(msg.usage.output_tokens) };
          const status = 'api_error_status' in msg ? msg.api_error_status : undefined;
          if (rateLimited || status === 429) {
            throw new AdapterError('RATE_LIMITED', 'Claude usage limit reached', rateLimitedUntil === undefined ? {} : { resetAt: rateLimitedUntil });
          }
          if (msg.subtype !== 'success' || msg.is_error) {
            const detail = msg.subtype === 'success' ? msg.result : msg.errors.join('; ');
            throw new AdapterError('ADAPTER_ERROR', `Claude Code turn failed (${msg.subtype}): ${detail}`);
          }
          if (sessionId === null) throw new AdapterError('ADAPTER_ERROR', 'Claude Code did not report a session id');
          return { nativeId: sessionId, text: msg.result, usage, contextTokens };
        }
      }
      if (controller.signal.aborted) throw new Error('aborted');
      throw new AdapterError(rateLimited ? 'RATE_LIMITED' : 'ADAPTER_ERROR', 'Claude Code ended without a result');
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      if (controller.signal.aborted) {
        throw timedOut
          ? new AdapterError('TIMEOUT', `turn exceeded ${opts.timeoutMs}ms`, { cause: error })
          : new AdapterError('CANCELLED', 'turn cancelled', { cause: error });
      }
      if (rateLimited) throw new AdapterError('RATE_LIMITED', 'Claude usage limit reached', { resetAt: rateLimitedUntil, cause: error });
      throw new AdapterError('ADAPTER_ERROR', error instanceof Error ? error.message : String(error), { cause: error });
    } finally {
      clearTimeout(timer);
      opts.signal.removeEventListener('abort', onAbort);
    }
  }
}

const defaultQuery: QueryFn = (params) => {
  // Loaded on first use so mock/opencode-only nodes never start the SDK.
  return (async function* () {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    yield* sdk.query(params);
  })();
};

export function createClaudeCodeAdapter(options: ClaudeCodeAdapterOptions): AgentAdapter {
  return new ClaudeCodeAdapter(options);
}
