import { z } from 'zod';
import { CommandSchema } from './commands.js';
import { OwnerSettingsSchema } from './config.js';
import { EventSchema } from './events.js';

// WebSocket /ws/node frame envelope — spec §11.1.

export const SessionReportSchema = z.object({
  sid: z.string().min(1),
  alive: z.boolean(),
  busy: z.boolean(),
  contextTokens: z.number().int().nonnegative(),
});
export type SessionReport = z.infer<typeof SessionReportSchema>;

export const NodeStatusSchema = z.object({
  settings: OwnerSettingsSchema,
  humanIdleSec: z.number().nonnegative().nullable(),
  rateLimitedUntil: z.number().int().nullable(),
  sessions: z.array(SessionReportSchema),
});
export type NodeStatus = z.infer<typeof NodeStatusSchema>;

const msgId = z.string().min(1);

export const HelloFrameSchema = z.object({
  kind: z.literal('hello'),
  agentId: z.string().min(1),
  token: z.string().min(1),
  nodeVersion: z.string(),
  /** Must equal PROTOCOL_VERSION; otherwise the Leader replies reject {version_mismatch}. */
  protocolVersion: z.number().int().positive(),
  settings: OwnerSettingsSchema,
  sessions: z.array(SessionReportSchema),
  adapterType: z.enum(['claude-code', 'opencode', 'mock']),
});

export const WelcomeFrameSchema = z.object({
  kind: z.literal('welcome'),
  serverTime: z.number().int(),
  heartbeatIntervalSec: z.number().int().positive(),
  // The Node has no copy of these Leader settings, so the Leader sends them on connect.
  resendUnackedSec: z.number().int().positive(),
  turnTimeoutSec: z.number().int().positive(),
  mainBranch: z.string().min(1),
});

export const RejectReasonSchema = z.enum(['bad_token', 'revoked', 'version_mismatch', 'already_connected']);
export type RejectReason = z.infer<typeof RejectReasonSchema>;

export const RejectFrameSchema = z.object({
  kind: z.literal('reject'),
  reason: RejectReasonSchema,
});

export const HeartbeatFrameSchema = z.object({
  kind: z.literal('heartbeat'),
  status: NodeStatusSchema,
});

export const CmdFrameSchema = z.object({
  kind: z.literal('cmd'),
  msgId,
  cmd: CommandSchema,
});

export const EvtFrameSchema = z.object({
  kind: z.literal('evt'),
  msgId,
  evt: EventSchema,
});

export const AckFrameSchema = z.object({
  kind: z.literal('ack'),
  msgId,
});

export const FrameSchema = z.discriminatedUnion('kind', [
  HelloFrameSchema,
  WelcomeFrameSchema,
  RejectFrameSchema,
  HeartbeatFrameSchema,
  CmdFrameSchema,
  EvtFrameSchema,
  AckFrameSchema,
]);
export type Frame = z.infer<typeof FrameSchema>;
export type FrameKind = Frame['kind'];
export type FrameOf<K extends FrameKind> = Extract<Frame, { kind: K }>;

export type HelloFrame = FrameOf<'hello'>;
export type WelcomeFrame = FrameOf<'welcome'>;
export type RejectFrame = FrameOf<'reject'>;
export type HeartbeatFrame = FrameOf<'heartbeat'>;
export type CmdFrame = FrameOf<'cmd'>;
export type EvtFrame = FrameOf<'evt'>;
export type AckFrame = FrameOf<'ack'>;

/** Frames the Node may send. */
export const NodeToLeaderFrameSchema = z.discriminatedUnion('kind', [
  HelloFrameSchema,
  HeartbeatFrameSchema,
  EvtFrameSchema,
  AckFrameSchema,
]);
export type NodeToLeaderFrame = z.infer<typeof NodeToLeaderFrameSchema>;

/** Frames the Leader may send. */
export const LeaderToNodeFrameSchema = z.discriminatedUnion('kind', [
  WelcomeFrameSchema,
  RejectFrameSchema,
  CmdFrameSchema,
  AckFrameSchema,
]);
export type LeaderToNodeFrame = z.infer<typeof LeaderToNodeFrameSchema>;

export type FrameParseResult<T> = { ok: true; frame: T } | { ok: false; error: string };

function parseWith<T>(schema: z.ZodType<T>, raw: string): FrameParseResult<T> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${(error as Error).message}` };
  }
  const result = schema.safeParse(json);
  return result.success ? { ok: true, frame: result.data } : { ok: false, error: z.prettifyError(result.error) };
}

export function parseNodeToLeaderFrame(raw: string): FrameParseResult<NodeToLeaderFrame> {
  return parseWith(NodeToLeaderFrameSchema, raw);
}

export function parseLeaderToNodeFrame(raw: string): FrameParseResult<LeaderToNodeFrame> {
  return parseWith(LeaderToNodeFrameSchema, raw);
}

export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame);
}
