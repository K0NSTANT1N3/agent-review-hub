// Spec §15.1. Owned by Codex-2 after scaffold C0.

export type Profile = 'author' | 'reviewer' | 'directive';

export interface TurnResult {
  /** Final assistant text of the turn. */
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  /** Best estimate of the session's current context size. */
  contextTokens: number;
}

export class AdapterError extends Error {
  readonly code: 'RATE_LIMITED' | 'ADAPTER_ERROR' | 'CANCELLED' | 'TIMEOUT';
  readonly resetAt?: number;

  constructor(
    code: AdapterError['code'],
    message: string = code,
    options?: { resetAt?: number; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AdapterError';
    this.code = code;
    if (options?.resetAt !== undefined) this.resetAt = options.resetAt;
  }
}

export interface AgentAdapter {
  /** Returns nativeId (may be null if the backend creates sessions lazily on first turn). */
  createSession(opts: { cwd: string; profile: Profile }): Promise<{ nativeId: string | null }>;
  /** Runs one turn. Returns updated nativeId (for lazily created sessions). */
  runTurn(opts: {
    nativeId: string | null;
    cwd: string;
    profile: Profile;
    prompt: string;
    signal: AbortSignal;
    timeoutMs: number;
  }): Promise<TurnResult & { nativeId: string }>;
  closeSession(nativeId: string): Promise<void>;
}
