import { z } from 'zod';
import { OwnerSettingsSchema } from './config.js';

// C0 subset. The full frame envelope (hello/welcome/cmd/evt/ack…) lands in C1.

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
