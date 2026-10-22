import { z } from 'zod';

/** Registry identifiers. Presence here does not imply a runtime implementation. */
export const ADAPTER_TYPES = ['claude-code', 'codex', 'pi', 'omp', 'opencode', 'kilo', 'custom', 'mock'] as const;
export const AdapterTypeSchema = z.enum(ADAPTER_TYPES);
export type AdapterType = z.infer<typeof AdapterTypeSchema>;

/** Reported by the Node, never an owner-selected permission setting. */
export const AgentTrustSchema = z.enum(['enforced', 'sandboxed', 'low']);
export type AgentTrust = z.infer<typeof AgentTrustSchema>;

/** Discovery metadata for the wire. Binary paths stay local to the Node. */
export const DetectedAgentSchema = z.object({
  type: AdapterTypeSchema,
  version: z.string().min(1).max(100),
  trust: AgentTrustSchema,
});
export type DetectedAgent = z.infer<typeof DetectedAgentSchema>;
