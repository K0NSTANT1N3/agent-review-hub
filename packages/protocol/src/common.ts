import { z } from 'zod';

export const PROTOCOL_VERSION = 1;

const nonNegativeInt = () => z.number().int().nonnegative();

// ---------------------------------------------------------------------------
// Enums — spec §7, §8.1
// ---------------------------------------------------------------------------

export const TASK_STATES = [
  'QUEUED',
  'AUTHORING',
  'AWAITING_REVIEWER',
  'IN_REVIEW',
  'MERGE_QUEUED',
  'MERGING',
  'SYNCING',
  'PAUSED',
  'ESCALATED',
  'MERGED',
  'CANCELLED',
  'FAILED',
] as const;
export const TaskStateSchema = z.enum(TASK_STATES);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const TERMINAL_TASK_STATES = ['MERGED', 'CANCELLED', 'FAILED'] as const satisfies readonly TaskState[];
export function isTerminalTaskState(state: TaskState): boolean {
  return (TERMINAL_TASK_STATES as readonly TaskState[]).includes(state);
}

export const TaskModeSchema = z.enum(['own', 'pool']);
export type TaskMode = z.infer<typeof TaskModeSchema>;

/** 0 low, 1 normal, 2 high, 3 urgent. */
export const TaskPrioritySchema = z.number().int().min(0).max(3);

export const SessionStateSchema = z.enum(['opening', 'idle', 'locked', 'closing', 'closed', 'lost']);
export type SessionState = z.infer<typeof SessionStateSchema>;

export const LockKindSchema = z.enum(['task', 'directive']);
export type LockKind = z.infer<typeof LockKindSchema>;

export const LockRoleSchema = z.enum(['author', 'reviewer', 'directive']);
export type LockRole = z.infer<typeof LockRoleSchema>;

export const ProfileSchema = z.enum(['author', 'reviewer', 'directive']);
export type SessionProfile = z.infer<typeof ProfileSchema>;

export const ConversationStateSchema = z.enum(['active', 'closed', 'abandoned']);
export type ConversationState = z.infer<typeof ConversationStateSchema>;

export const IssueSeveritySchema = z.enum(['blocking', 'suggestion']);
export type IssueSeverity = z.infer<typeof IssueSeveritySchema>;

export const IssueSourceSchema = z.enum(['reviewer', 'human', 'system']);
export type IssueSource = z.infer<typeof IssueSourceSchema>;

export const IssueStatusSchema = z.enum(['open', 'resolved', 'closed_by_human']);
export type IssueStatus = z.infer<typeof IssueStatusSchema>;

export const AuthorActionSchema = z.enum(['fixed', 'disputed', 'wontfix']);
export type AuthorAction = z.infer<typeof AuthorActionSchema>;

export const DirectiveStateSchema = z.enum(['queued', 'running', 'done', 'failed', 'cancelled']);
export type DirectiveState = z.infer<typeof DirectiveStateSchema>;

export const AgentStatusSchema = z.enum(['online', 'offline']);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

// ---------------------------------------------------------------------------
// Shared payload pieces — spec §11.4, §11.5
// ---------------------------------------------------------------------------

/** Issue codes are 'I1', 'I2', … unique per task. */
export const IssueCodeSchema = z.string().regex(/^I[1-9][0-9]*$/);

export const TaskBriefSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1),
  description: z.string(),
  tags: z.array(z.string()),
  /** Owner name of the requesting developer. */
  requester: z.string().min(1),
});
export type TaskBrief = z.infer<typeof TaskBriefSchema>;

export const IssueBriefSchema = z.object({
  code: IssueCodeSchema,
  severity: IssueSeveritySchema,
  source: IssueSourceSchema,
  file: z.string().nullable(),
  line: z.number().int().positive().nullable(),
  comment: z.string().min(1),
});
export type IssueBrief = z.infer<typeof IssueBriefSchema>;

export const OpenIssueWithResponseSchema = IssueBriefSchema.extend({
  authorResponse: AuthorActionSchema.nullable(),
  authorNote: z.string().nullable(),
});
export type OpenIssueWithResponse = z.infer<typeof OpenIssueWithResponseSchema>;

export const UsageSchema = z.object({
  inputTokens: nonNegativeInt(),
  outputTokens: nonNegativeInt(),
  contextTokens: nonNegativeInt(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const TestResultSchema = z.object({
  passed: z.boolean(),
  exitCode: z.number().int().nullable(),
  /** Last 200 lines of combined stdout/stderr, capped at 20 KB. */
  outputTail: z.string(),
  durationMs: nonNegativeInt(),
  timedOut: z.boolean(),
});
export type TestResult = z.infer<typeof TestResultSchema>;

export const GitShaSchema = z.string().regex(/^[0-9a-f]{7,64}$/);
