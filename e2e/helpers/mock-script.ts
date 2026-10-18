// Mock adapter script format — spec §15.4 (implemented by Codex-2 in packages/node/src/adapters/mock.ts).

export interface MockTurn {
  /** Files written into the session's worktree before replying (paths relative to the repo root). */
  writeFiles?: Record<string, string>;
  /** Object emitted inside a ```quorum-json block. */
  reply?: unknown;
  /** Emitted verbatim instead of `reply` (to exercise invalid output). */
  rawReply?: string;
  failTurnWith?: 'RATE_LIMITED' | 'ADAPTER_ERROR' | 'INVALID_OUTPUT' | null;
}

export interface MockRule {
  match: { taskTitleContains?: string; any?: boolean };
  turns: MockTurn[];
}

export interface MockScript {
  author?: MockRule[];
  reviewer?: MockRule[];
  directive?: MockRule[];
  behaviors?: {
    failTurnWith?: MockTurn['failTurnWith'];
    delayMs?: number;
    tokensPerTurn?: { input: number; output: number };
  };
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export const authorDone = (files: Record<string, string>, summary = 'implemented'): MockTurn => ({
  writeFiles: files,
  reply: { status: 'done', summary },
});

export const authorBlocked = (blockedReason: string): MockTurn => ({
  reply: { status: 'blocked', summary: 'need input', blockedReason },
});

export const authorRevised = (
  files: Record<string, string>,
  responses: { issue: string; action: 'fixed' | 'disputed' | 'wontfix'; note?: string }[],
  summary = 'revised',
): MockTurn => ({
  writeFiles: files,
  reply: { status: 'done', summary, responses: responses.map((r) => ({ note: '', ...r })) },
});

/** Reply to the §12.8 conflict-resolution prompt. */
export const syncResolved = (files: Record<string, string>): MockTurn => ({
  writeFiles: files,
  reply: { status: 'done', summary: 'resolved conflicts' },
});

export const approve = (previous: { issue: string; status: 'resolved' | 'still_open' }[] = []): MockTurn => ({
  reply: { verdict: 'approve', summary: 'looks good', previousIssues: previous, newIssues: [] },
});

export const requestChanges = (
  comment: string,
  previous: { issue: string; status: 'resolved' | 'still_open' }[] = [],
): MockTurn => ({
  reply: {
    verdict: 'request_changes',
    summary: 'changes needed',
    previousIssues: previous,
    newIssues: [{ severity: 'blocking', file: 'src/greet.js', line: 1, comment }],
  },
});

export const directiveAnswer = (answer: string): MockTurn => ({ reply: { answer } });

export const anyTask = (turns: MockTurn[]): MockRule[] => [{ match: { any: true }, turns }];
export const forTask = (titleContains: string, turns: MockTurn[]): MockRule => ({ match: { taskTitleContains: titleContains }, turns });
