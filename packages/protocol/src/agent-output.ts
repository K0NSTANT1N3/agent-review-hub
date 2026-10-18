import { z } from 'zod';
import { AuthorActionSchema, IssueCodeSchema, IssueSeveritySchema } from './common.js';

// Structured blocks agents must end each turn with — spec §12.
// Coverage checks (responses/previousIssues must cover exactly the supplied codes) depend on
// the command and live in the Node's output parser (N4); use the helpers at the bottom.

export const QUORUM_JSON_FENCE = 'quorum-json';

const summary = z.string().min(1).max(4000);

// §12.3 author.start
export const AuthorStartOutputSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('done'), summary }),
  z.object({ status: z.literal('blocked'), summary, blockedReason: z.string().min(1) }),
]);
export type AuthorStartOutput = z.infer<typeof AuthorStartOutputSchema>;

// §12.4 author.revise
export const AuthorResponseSchema = z.object({
  issue: IssueCodeSchema,
  action: AuthorActionSchema,
  note: z.string().default(''),
});
export type AuthorResponse = z.infer<typeof AuthorResponseSchema>;

export const AuthorReviseOutputSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('done'), summary, responses: z.array(AuthorResponseSchema) }),
  z.object({
    status: z.literal('blocked'),
    summary,
    blockedReason: z.string().min(1),
    responses: z.array(AuthorResponseSchema).default([]),
  }),
]);
export type AuthorReviseOutput = z.infer<typeof AuthorReviseOutputSchema>;

// §12.5 / §12.6 review.start and review.rereview
export const PreviousIssueVerdictSchema = z.object({
  issue: IssueCodeSchema,
  status: z.enum(['resolved', 'still_open']),
  comment: z.string().optional(),
});
export type PreviousIssueVerdict = z.infer<typeof PreviousIssueVerdictSchema>;

export const NewIssueSchema = z.object({
  severity: IssueSeveritySchema,
  file: z.string().min(1).nullable().default(null),
  line: z.number().int().positive().nullable().default(null),
  comment: z.string().min(1),
});
export type NewIssue = z.infer<typeof NewIssueSchema>;

export const ReviewOutputSchema = z.object({
  verdict: z.enum(['approve', 'request_changes']),
  summary,
  previousIssues: z.array(PreviousIssueVerdictSchema).default([]),
  newIssues: z.array(NewIssueSchema).max(30).default([]),
});
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

// §12.7 summarize (compaction)
export const SummarizeOutputSchema = z.object({ summary: z.string().min(1) });
export type SummarizeOutput = z.infer<typeof SummarizeOutputSchema>;

// §12.8 conflict resolution during author.sync
export const SyncOutputSchema = z.object({ status: z.literal('done'), summary });
export type SyncOutput = z.infer<typeof SyncOutputSchema>;

// §12.9 directive.run
export const DirectiveOutputSchema = z.object({ answer: z.string().min(1) });
export type DirectiveOutput = z.infer<typeof DirectiveOutputSchema>;

// ---------------------------------------------------------------------------
// Coverage helpers
// ---------------------------------------------------------------------------

export interface CoverageResult {
  ok: boolean;
  missing: string[];
  unexpected: string[];
  duplicated: string[];
}

/** Every expected code must appear exactly once; no other codes are allowed. */
export function checkCoverage(actualCodes: readonly string[], expectedCodes: readonly string[]): CoverageResult {
  const expected = new Set(expectedCodes);
  const seen = new Map<string, number>();
  for (const code of actualCodes) seen.set(code, (seen.get(code) ?? 0) + 1);
  const missing = [...expected].filter((c) => !seen.has(c));
  const unexpected = [...seen.keys()].filter((c) => !expected.has(c));
  const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([c]) => c);
  return { ok: missing.length === 0 && unexpected.length === 0 && duplicated.length === 0, missing, unexpected, duplicated };
}
