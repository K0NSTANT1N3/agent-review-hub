import { z } from 'zod';
import { AuthorResponseSchema, ReviewOutputSchema } from './agent-output.js';
import { GitShaSchema, TestResultSchema, UsageSchema } from './common.js';

// Node → Leader events — spec §11.5.

const sid = z.string().min(1);
const inReplyTo = z.string().min(1);
const taskId = z.number().int().positive();

export const SessionOpenedEventSchema = z.object({
  type: z.literal('session.opened'),
  inReplyTo,
  sid,
  ok: z.boolean(),
  error: z.string().optional(),
});

export const SessionClosedEventSchema = z.object({
  type: z.literal('session.closed'),
  inReplyTo,
  sid,
});

export const SessionCompactedEventSchema = z.object({
  type: z.literal('session.compacted'),
  sid,
  contextTokensBefore: z.number().int().nonnegative(),
  contextTokensAfter: z.number().int().nonnegative(),
});

export const AuthorCheckpointEventSchema = z.object({
  type: z.literal('author.checkpoint'),
  sid,
  taskId,
  commit: GitShaSchema,
});

export const AuthorSubmittedEventSchema = z.object({
  type: z.literal('author.submitted'),
  inReplyTo,
  sid,
  taskId,
  status: z.enum(['done', 'blocked']),
  blockedReason: z.string().optional(),
  summary: z.string(),
  /** Empty for author.start; one entry per blocking issue for author.revise. */
  responses: z.array(AuthorResponseSchema),
  headCommit: GitShaSchema,
  baseCommit: GitShaSchema,
  filesChanged: z.array(z.string()),
  diffLines: z.number().int().nonnegative(),
  tests: TestResultSchema,
  usage: UsageSchema,
});

export const AuthorSyncedEventSchema = z.object({
  type: z.literal('author.synced'),
  inReplyTo,
  sid,
  taskId,
  headCommit: GitShaSchema,
  hadConflicts: z.boolean(),
  tests: TestResultSchema,
  usage: UsageSchema,
});

export const ReviewCompletedEventSchema = z.object({
  type: z.literal('review.completed'),
  inReplyTo,
  sid,
  taskId,
  conversationId: z.string().min(1),
  reviewedCommit: GitShaSchema,
  output: ReviewOutputSchema,
  usage: UsageSchema,
});

export const DirectiveCompletedEventSchema = z.object({
  type: z.literal('directive.completed'),
  inReplyTo,
  sid,
  directiveId: z.string().min(1),
  text: z.string(),
  usage: UsageSchema,
});

export const TurnFailureCodeSchema = z.enum([
  'RATE_LIMITED',
  'ADAPTER_ERROR',
  'INVALID_OUTPUT',
  'CANCELLED',
  'TIMEOUT',
  'INTERRUPTED',
  'GIT_ERROR',
]);
export type TurnFailureCode = z.infer<typeof TurnFailureCodeSchema>;

export const TurnFailedEventSchema = z.object({
  type: z.literal('turn.failed'),
  inReplyTo,
  sid,
  taskId: taskId.optional(),
  directiveId: z.string().min(1).optional(),
  code: TurnFailureCodeSchema,
  message: z.string(),
  resetAt: z.number().int().optional(),
  usage: UsageSchema.optional(),
});

export const SessionLostEventSchema = z.object({
  type: z.literal('session.lost'),
  sid,
  reason: z.string(),
});

export const EventSchema = z.discriminatedUnion('type', [
  SessionOpenedEventSchema,
  SessionClosedEventSchema,
  SessionCompactedEventSchema,
  AuthorCheckpointEventSchema,
  AuthorSubmittedEventSchema,
  AuthorSyncedEventSchema,
  ReviewCompletedEventSchema,
  DirectiveCompletedEventSchema,
  TurnFailedEventSchema,
  SessionLostEventSchema,
]);
export type Event = z.infer<typeof EventSchema>;
export type EventType = Event['type'];
export type EventOf<T extends EventType> = Extract<Event, { type: T }>;

export type SessionOpenedEvent = EventOf<'session.opened'>;
export type SessionClosedEvent = EventOf<'session.closed'>;
export type SessionCompactedEvent = EventOf<'session.compacted'>;
export type AuthorCheckpointEvent = EventOf<'author.checkpoint'>;
export type AuthorSubmittedEvent = EventOf<'author.submitted'>;
export type AuthorSyncedEvent = EventOf<'author.synced'>;
export type ReviewCompletedEvent = EventOf<'review.completed'>;
export type DirectiveCompletedEvent = EventOf<'directive.completed'>;
export type TurnFailedEvent = EventOf<'turn.failed'>;
export type SessionLostEvent = EventOf<'session.lost'>;

export const EVENT_TYPES = EventSchema.options.map((o) => o.shape.type.value) as EventType[];
