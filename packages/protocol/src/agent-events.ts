import { z } from 'zod';

export const MAX_TOOL_OUTPUT_BYTES = 4096;
export const MAX_AGENT_EVENT_BATCH = 100;

const counter = () => z.number().int().nonnegative();
const id = z.string().min(1).max(256);
const text = z.string().max(16384);
const base = z.object({
  /** Starts at 1. Increases across all turns and native-session compactions of one sid. */
  seq: z.number().int().positive(),
  /** Node observation time, in milliseconds since the Unix epoch. */
  at: counter(),
});

export const AgentToolKindSchema = z.enum(['read', 'edit', 'write', 'bash', 'search', 'other']);
export const AgentTextModeSchema = z.enum(['delta', 'final']);

/**
 * Small display events. Raw arguments, patches and provider payloads stay on the Node.
 * Adapters split text longer than 16384 characters into consecutive events of the
 * same kind and, for text events, the same mode. Preserve messageId across chunks
 * and deltas belonging to one assistant message.
 * Consumers concatenate consecutive `final` chunks with the same messageId into
 * one snapshot, then replace that message's accumulated deltas with the snapshot.
 */
export const AgentEventSchema = z.discriminatedUnion('kind', [
  base.extend({ kind: z.literal('text'), mode: AgentTextModeSchema, text, messageId: id.optional() }),
  /** Thinking contains deltas, or one snapshot when the source has no deltas. */
  base.extend({ kind: z.literal('thinking'), text, messageId: id.optional() }),
  base.extend({
    kind: z.literal('tool_call'),
    id,
    name: z.string().min(1).max(100),
    toolKind: AgentToolKindSchema,
    argsSummary: z.string().max(256),
    paths: z.array(z.string().min(1).max(1024)).max(20).optional(),
  }),
  base.extend({
    kind: z.literal('tool_result'),
    id,
    ok: z.boolean(),
    exitCode: z.number().int().optional(),
    /** The adapter truncates at a UTF-8 boundary before validation. */
    output: z.string().max(MAX_TOOL_OUTPUT_BYTES).refine(
      (value) => new TextEncoder().encode(value).byteLength <= MAX_TOOL_OUTPUT_BYTES,
      { message: 'output must be at most 4096 UTF-8 bytes' },
    ),
  }),
  base.extend({
    kind: z.literal('usage'),
    /** Omit unavailable counters. Never substitute cumulative input for context size. */
    inputTokens: counter().optional(),
    outputTokens: counter().optional(),
    contextTokens: counter().optional(),
  }).refine(
    (value) => value.inputTokens !== undefined || value.outputTokens !== undefined || value.contextTokens !== undefined,
    { message: 'at least one token counter is required' },
  ),
  base.extend({ kind: z.literal('status'), text: z.string().min(1).max(256) }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

/** Cross-batch monotonicity and replay deduplication require persisted per-sid state. */
export const AgentEventBatchSchema = z.array(AgentEventSchema).min(1).max(MAX_AGENT_EVENT_BATCH).superRefine((events, ctx) => {
  for (let i = 1; i < events.length; i++) {
    if (events[i]!.seq <= events[i - 1]!.seq) {
      ctx.addIssue({ code: 'custom', path: [i, 'seq'], message: 'seq must strictly increase within a session batch' });
    }
  }
});

export const TranscriptBatchSchema = z.object({
  sid: z.string().min(1),
  taskId: z.number().int().positive(),
  events: AgentEventBatchSchema,
});
export type TranscriptBatch = z.infer<typeof TranscriptBatchSchema>;
