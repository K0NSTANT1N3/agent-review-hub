import { z } from 'zod';

// Nested objects use .prefault({}) so that an omitted section still receives its inner defaults.

const positiveInt = () => z.number().int().positive();
const nonNegativeInt = () => z.number().int().nonnegative();

export const LendModeSchema = z.enum(['always', 'when_idle', 'never']);
export type LendMode = z.infer<typeof LendModeSchema>;

// ---------------------------------------------------------------------------
// Leader config — spec §6.1
// ---------------------------------------------------------------------------

export const LeaderConfigSchema = z.object({
  listen: z
    .object({
      host: z.string().default('0.0.0.0'),
      port: z.number().int().min(0).max(65535).default(7420),
    })
    .prefault({}),
  tls: z
    .object({
      certFile: z.string().nullable().default(null),
      keyFile: z.string().nullable().default(null),
    })
    .prefault({}),
  dbPath: z.string().default('./data/leader.db'),
  repo: z.object({
    remoteUrl: z.string().min(1),
    mainBranch: z.string().default('main'),
    clonePath: z.string().default('./data/repo'),
    branchPrefix: z.string().default('quorum/task-'),
    deleteBranchOnFinish: z.boolean().default(true),
    mergeStrategy: z.literal('squash').default('squash'),
  }),
  admins: z.array(z.string()).default([]),
  dayBoundaryTz: z.string().default('UTC'),
  timeouts: z
    .object({
      heartbeatIntervalSec: positiveInt().default(10),
      agentOfflineAfterSec: positiveInt().default(30),
      leaseSec: positiveInt().default(120),
      authorReconnectGraceSec: positiveInt().default(600),
      turnTimeoutSec: positiveInt().default(1800),
      resendUnackedSec: positiveInt().default(10),
      idleSessionTtlMin: positiveInt().default(60),
      noReviewerNotifyAfterSec: positiveInt().default(1800),
      mergeTestTimeoutSec: positiveInt().default(900),
    })
    .prefault({}),
  limits: z
    .object({
      maxReviewRounds: positiveInt().default(3),
      maxTestFixAttempts: positiveInt().default(3),
      maxSyncAttempts: positiveInt().default(3),
      maxTurnRetries: nonNegativeInt().default(2),
      maxDisputesPerIssue: positiveInt().default(2),
      maxMergePushRetries: positiveInt().default(3),
    })
    .prefault({}),
  scheduler: z
    .object({
      tickMs: positiveInt().default(2000),
      agingMinutesPerPriorityPoint: z.number().positive().default(30),
      affinityLookbackHours: z.number().positive().default(24),
      pairPenaltyLookbackDays: z.number().positive().default(7),
      sessionReuseMinAffinity: z.number().min(0).max(1).default(0.3),
      sessionReuseMaxContextPct: z.number().min(0).max(1).default(0.6),
      weights: z
        .object({
          affinity: z.number().default(3.0),
          headroom: z.number().default(2.0),
          idleness: z.number().default(1.5),
          expertise: z.number().default(1.0),
          pairPenalty: z.number().default(1.0),
          fairness: z.number().default(0.5),
          requesterBonus: z.number().default(1.0),
        })
        .prefault({}),
    })
    .prefault({}),
  costEstimate: z
    .object({
      baseTokens: nonNegativeInt().default(4000),
      perDiffLine: z.number().nonnegative().default(12),
      perChangedFile: z.number().nonnegative().default(1500),
      authorTaskTokens: nonNegativeInt().default(60000),
      emaAlpha: z.number().min(0).max(1).default(0.2),
    })
    .prefault({}),
});
export type LeaderConfig = z.output<typeof LeaderConfigSchema>;
export type LeaderConfigInput = z.input<typeof LeaderConfigSchema>;

export function parseLeaderConfig(input: unknown): LeaderConfig {
  return LeaderConfigSchema.parse(input);
}

// ---------------------------------------------------------------------------
// Node config — spec §6.2
// ---------------------------------------------------------------------------

export const ClaudeCodeAdapterConfigSchema = z.object({
  type: z.literal('claude-code'),
  model: z.string().optional(),
  contextWindow: positiveInt().default(200000),
});
export const OpencodeAdapterConfigSchema = z.object({
  type: z.literal('opencode'),
  baseUrl: z.string().url(),
  providerID: z.string().min(1),
  modelID: z.string().min(1),
  contextWindow: positiveInt().default(200000),
});
export const MockAdapterConfigSchema = z.object({
  type: z.literal('mock'),
  scriptPath: z.string().min(1),
  contextWindow: positiveInt().default(200000),
});
export const AdapterConfigSchema = z.discriminatedUnion('type', [
  ClaudeCodeAdapterConfigSchema,
  OpencodeAdapterConfigSchema,
  MockAdapterConfigSchema,
]);
export type AdapterConfig = z.output<typeof AdapterConfigSchema>;
export type AdapterType = AdapterConfig['type'];

export const DEFAULT_AUTHOR_BASH_ALLOW = [
  'npm test',
  'npm run',
  'npx tsc',
  'pnpm test',
  'pnpm run',
  'yarn test',
  'yarn run',
  'node --test',
  'go test',
  'cargo test',
  'pytest',
  'python -m pytest',
  'make test',
  'ls',
  'git status',
  'git diff',
  'git log',
] as const;

export const NodeConfigSchema = z.object({
  leaderUrl: z.string().min(1),
  agentId: z.string().min(1),
  token: z.string().min(1),
  ownerName: z.string().min(1),
  dataDir: z.string().default('~/.quorum/node'),
  workspaceDir: z.string().default('~/.quorum/workspace'),
  repoRemoteUrl: z.string().min(1),
  gitIdentity: z.object({ name: z.string().min(1), email: z.string().min(1) }),
  adapter: AdapterConfigSchema,
  maxSessions: positiveInt().default(2),
  lendMode: LendModeSchema.default('when_idle'),
  idleThresholdSec: nonNegativeInt().default(300),
  lendTokensPerDay: nonNegativeInt().default(2000000),
  paused: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
  authorBashAllow: z.array(z.string()).default([...DEFAULT_AUTHOR_BASH_ALLOW]),
  contextPressurePct: z.number().gt(0).max(1).default(0.75),
  maxInvalidOutputRetries: nonNegativeInt().default(2),
  maxDiffLinesInPrompt: positiveInt().default(3000),
});
export type NodeConfig = z.output<typeof NodeConfigSchema>;
export type NodeConfigInput = z.input<typeof NodeConfigSchema>;

export function parseNodeConfig(input: unknown): NodeConfig {
  return NodeConfigSchema.parse(input);
}

// ---------------------------------------------------------------------------
// Owner settings — spec §6.2 (sent in hello/heartbeat, editable live)
// ---------------------------------------------------------------------------

export const OwnerSettingsSchema = z.object({
  maxSessions: positiveInt(),
  lendMode: LendModeSchema,
  lendTokensPerDay: nonNegativeInt(),
  paused: z.boolean(),
  tags: z.array(z.string()),
  contextWindow: positiveInt(),
  idleThresholdSec: nonNegativeInt(),
});
export type OwnerSettings = z.infer<typeof OwnerSettingsSchema>;

export function ownerSettingsFromNodeConfig(config: NodeConfig): OwnerSettings {
  return {
    maxSessions: config.maxSessions,
    lendMode: config.lendMode,
    lendTokensPerDay: config.lendTokensPerDay,
    paused: config.paused,
    tags: [...config.tags],
    contextWindow: config.adapter.contextWindow,
    idleThresholdSec: config.idleThresholdSec,
  };
}

// ---------------------------------------------------------------------------
// Project config (quorum.json on main) — spec §6.3
// ---------------------------------------------------------------------------

export const ProjectConfigSchema = z.object({
  setupCommand: z.string().min(1).nullable().default(null),
  testCommand: z.string().min(1).nullable().default(null),
  testTimeoutSec: positiveInt().default(900),
});
export type ProjectConfig = z.output<typeof ProjectConfigSchema>;

export function parseProjectConfig(input: unknown): ProjectConfig {
  return ProjectConfigSchema.parse(input);
}
