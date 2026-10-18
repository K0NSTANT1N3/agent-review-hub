import { z } from 'zod';
import {
  GitShaSchema,
  IssueBriefSchema,
  OpenIssueWithResponseSchema,
  ProfileSchema,
  TaskBriefSchema,
} from './common.js';

// Leader → Node commands — spec §11.4.

const sid = z.string().min(1);
const taskId = z.number().int().positive();
const conversationId = z.string().min(1);
const round = z.number().int().positive();
const estimated = z.number().int().nonnegative();

export const SessionOpenCommandSchema = z.object({
  type: z.literal('session.open'),
  sid,
  profile: ProfileSchema,
});

export const SessionCloseCommandSchema = z.object({
  type: z.literal('session.close'),
  sid,
});

export const AuthorStartCommandSchema = z.object({
  type: z.literal('author.start'),
  sid,
  taskId,
  task: TaskBriefSchema,
  branch: z.string().min(1),
  /** True when the branch already has another agent's work (spec T24 reassignment). */
  continueExisting: z.boolean(),
  /** Full issue history; empty for a fresh task. */
  issues: z.array(IssueBriefSchema),
  estimated,
});

export const AuthorReviseCommandSchema = z.object({
  type: z.literal('author.revise'),
  sid,
  taskId,
  /** null when revising for test failures with no active conversation. */
  conversationId: conversationId.nullable(),
  round: z.number().int().nonnegative(),
  task: TaskBriefSchema,
  branch: z.string().min(1),
  openIssues: z.array(IssueBriefSchema),
  suggestions: z.array(IssueBriefSchema),
  testFailure: z.string().nullable(),
  estimated,
});

export const AuthorSyncCommandSchema = z.object({
  type: z.literal('author.sync'),
  sid,
  taskId,
  branch: z.string().min(1),
  mainBranch: z.string().min(1),
  estimated,
});

export const ReviewStartCommandSchema = z.object({
  type: z.literal('review.start'),
  sid,
  taskId,
  conversationId,
  round,
  task: TaskBriefSchema,
  branch: z.string().min(1),
  baseCommit: GitShaSchema,
  headCommit: GitShaSchema,
  testSummary: z.string(),
  /** Open issues raised by a previous (abandoned) conversation. */
  priorIssues: z.array(IssueBriefSchema),
  estimated,
});

export const ReviewRereviewCommandSchema = z.object({
  type: z.literal('review.rereview'),
  sid,
  taskId,
  conversationId,
  round,
  task: TaskBriefSchema,
  fromCommit: GitShaSchema,
  headCommit: GitShaSchema,
  baseCommit: GitShaSchema,
  openIssues: z.array(OpenIssueWithResponseSchema),
  authorSummary: z.string(),
  reason: z.enum(['revision', 'sync_conflicts']),
  estimated,
});

export const DirectiveRunCommandSchema = z.object({
  type: z.literal('directive.run'),
  sid,
  directiveId: z.string().min(1),
  /** Owner name of the human who sent the directive (used in the §12.9 prompt). */
  requester: z.string().min(1),
  text: z.string().min(1),
  estimated,
});

export const TaskCancelCommandSchema = z.object({
  type: z.literal('task.cancel'),
  sid,
  taskId: taskId.optional(),
  directiveId: z.string().min(1).optional(),
});

export const CommandSchema = z.discriminatedUnion('type', [
  SessionOpenCommandSchema,
  SessionCloseCommandSchema,
  AuthorStartCommandSchema,
  AuthorReviseCommandSchema,
  AuthorSyncCommandSchema,
  ReviewStartCommandSchema,
  ReviewRereviewCommandSchema,
  DirectiveRunCommandSchema,
  TaskCancelCommandSchema,
]);
export type Command = z.infer<typeof CommandSchema>;
export type CommandType = Command['type'];
export type CommandOf<T extends CommandType> = Extract<Command, { type: T }>;

export type SessionOpenCommand = CommandOf<'session.open'>;
export type SessionCloseCommand = CommandOf<'session.close'>;
export type AuthorStartCommand = CommandOf<'author.start'>;
export type AuthorReviseCommand = CommandOf<'author.revise'>;
export type AuthorSyncCommand = CommandOf<'author.sync'>;
export type ReviewStartCommand = CommandOf<'review.start'>;
export type ReviewRereviewCommand = CommandOf<'review.rereview'>;
export type DirectiveRunCommand = CommandOf<'directive.run'>;
export type TaskCancelCommand = CommandOf<'task.cancel'>;

export const COMMAND_TYPES = CommandSchema.options.map((o) => o.shape.type.value) as CommandType[];

/** Commands that run an LLM turn (and therefore report usage / may fail with turn.failed). */
export const TURN_COMMAND_TYPES = [
  'author.start',
  'author.revise',
  'author.sync',
  'review.start',
  'review.rereview',
  'directive.run',
] as const satisfies readonly CommandType[];
