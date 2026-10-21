import { LeaderConfigSchema, type LeaderConfig } from '@quorum/protocol';
import { z } from 'zod';

export const DEFAULT_TRANSCRIPT_MAX_BYTES_PER_TASK = 8 * 1024 * 1024;

// Leader-only retention settings stay out of the Node's wire configuration.
export const LeaderRuntimeConfigSchema = LeaderConfigSchema.extend({
  transcriptMaxBytesPerTask: z.number().int().positive().default(DEFAULT_TRANSCRIPT_MAX_BYTES_PER_TASK),
});
export type LeaderRuntimeConfig = z.infer<typeof LeaderRuntimeConfigSchema>;
export type LeaderConfigWithRetention = LeaderConfig & Partial<Pick<LeaderRuntimeConfig, 'transcriptMaxBytesPerTask'>>;
