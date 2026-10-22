import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ADAPTER_TYPES,
  API_ROUTES,
  AdapterConfigSchema,
  AdapterTypeSchema,
  AgentEventBatchSchema,
  AgentEventSchema,
  AgentViewSchema,
  ApiTokenViewSchema,
  CreateApiTokenRequestSchema,
  DetectedAgentSchema,
  HelloFrameSchema,
  MAX_AGENT_EVENT_BATCH,
  MAX_TOOL_OUTPUT_BYTES,
  NodeStatusSchema,
  OwnerSettingsSchema,
  PROTOCOL_VERSION,
  SessionReportSchema,
  TaskTranscriptQuerySchema,
  TaskTranscriptResponseSchema,
  TokenScopeSchema,
  UiEventSchema,
  WelcomeFrameSchema,
  apiPath,
  encodeFrame,
  parseLeaderToNodeFrame,
  parseNodeConfig,
  parseNodeToLeaderFrame,
  type AgentEvent,
  type ApiResponse,
  type OwnerSettings,
  type TranscriptFrame,
} from '../src/index.js';

const at = 1_792_529_000_000;
const settings: OwnerSettings = {
  maxSessions: 2, lendMode: 'always', lendTokensPerDay: 1000, paused: false,
  tags: [], contextWindow: 200000, idleThresholdSec: 300,
};
const hello = {
  kind: 'hello' as const, agentId: 'alice', token: 'qrm_test', nodeVersion: '0.1.0',
  protocolVersion: PROTOCOL_VERSION, settings, sessions: [], adapterType: 'mock' as const,
};
const status = { settings, humanIdleSec: null, rateLimitedUntil: null, sessions: [] };
const detected = { type: 'codex' as const, version: '0.163.0', trust: 'sandboxed' as const };
const events: AgentEvent[] = [
  { kind: 'text', mode: 'delta', text: 'Hello', messageId: 'turn-1:message-0', seq: 1, at },
  { kind: 'text', mode: 'final', text: 'Hello world', messageId: 'turn-1:message-0', seq: 2, at },
  { kind: 'thinking', text: 'Check callers.', messageId: 'turn-1:message-0', seq: 3, at },
  { kind: 'tool_call', id: 'turn-1:item-0', name: 'read', toolKind: 'read', argsSummary: 'src/x.ts', paths: ['src/x.ts'], seq: 4, at },
  { kind: 'tool_result', id: 'turn-1:item-0', ok: true, output: 'source', seq: 5, at },
  { kind: 'tool_result', id: 'turn-1:item-1', ok: false, exitCode: 1, output: 'failed', seq: 6, at },
  { kind: 'usage', inputTokens: 100, outputTokens: 5, contextTokens: 105, seq: 7, at },
  { kind: 'status', text: 'reading src/x.ts', seq: 8, at },
];

describe('normalized agent events', () => {
  it('round-trips every kind and preserves final versus delta text', () => {
    expect(new Set(events.map((event) => event.kind))).toEqual(new Set(AgentEventSchema.options.map((option) => option.shape.kind.value)));
    for (const event of events) expect(AgentEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
  });

  it.each(['read', 'edit', 'write', 'bash', 'search', 'other'])('accepts tool kind %s', (toolKind) => {
    expect(AgentEventSchema.safeParse({ ...events[3], toolKind }).success).toBe(true);
  });

  it('requires the variant fields and safe integer sequence and observation time', () => {
    const invalid = [
      { kind: 'unknown', seq: 1, at },
      { ...events[0], mode: 'snapshot' },
      { ...events[0], seq: 0 }, { ...events[0], seq: 1.5 }, { ...events[0], seq: Number.MAX_SAFE_INTEGER + 1 },
      { ...events[0], at: -1 }, { ...events[0], at: Infinity }, { ...events[0], at: 0.5 },
      { ...events[3], id: '' }, { ...events[3], toolKind: 'delete' }, { ...events[3], argsSummary: undefined },
      { ...events[4], ok: undefined }, { ...events[4], exitCode: null }, { ...events[4], exitCode: 0.5 },
      { kind: 'text', text: 'x', seq: 1, at },
      { kind: 'thinking', seq: 1, at },
      { kind: 'status', text: '', seq: 1, at },
    ];
    for (const event of invalid) expect(AgentEventSchema.safeParse(event).success, JSON.stringify(event)).toBe(false);
  });

  it('caps tool output at 4096 UTF-8 bytes, including multibyte text', () => {
    expect(MAX_TOOL_OUTPUT_BYTES).toBe(4096);
    for (const output of ['a'.repeat(4096), '😀'.repeat(1024), 'é'.repeat(2048)]) {
      expect(AgentEventSchema.safeParse({ ...events[4], output }).success).toBe(true);
      expect(AgentEventSchema.safeParse({ ...events[4], output: `${output}a` }).success).toBe(false);
    }
  });

  it.each([
    { kind: 'text', mode: 'delta' },
    { kind: 'text', mode: 'final' },
    { kind: 'thinking' },
  ])('bounds $kind $mode text and optional assistant message IDs', (variant) => {
    const event = { ...variant, text: 'a'.repeat(16384), seq: 1, at };
    expect(AgentEventSchema.parse(event)).toEqual(event);
    expect(AgentEventSchema.safeParse({ ...event, text: 'a'.repeat(16385) }).success).toBe(false);
    for (const messageId of ['turn-1:message-0', 'a'.repeat(256)]) {
      expect(AgentEventSchema.parse({ ...event, messageId })).toEqual({ ...event, messageId });
    }
    for (const messageId of ['', 'a'.repeat(257), null, 1]) {
      expect(AgentEventSchema.safeParse({ ...event, messageId }).success).toBe(false);
    }
  });

  it('round-trips consecutive final chunks without losing a long quorum-json reply', () => {
    const reply = `${'a'.repeat(17000)}\n\`\`\`quorum-json\n{"status":"done"}\n\`\`\``;
    const chunks = [reply.slice(0, 16384), reply.slice(16384)];
    const batch = chunks.map((text, i) => ({ kind: 'text', mode: 'final', text, messageId: 'reply-1', seq: i + 1, at }));
    expect(AgentEventBatchSchema.parse(JSON.parse(JSON.stringify(batch)))).toEqual(batch);
  });

  it('bounds display fields and strips raw provider data', () => {
    expect(AgentEventSchema.safeParse({ ...events[3], argsSummary: 'a'.repeat(257) }).success).toBe(false);
    expect(AgentEventSchema.safeParse({ ...events[3], paths: Array.from({ length: 21 }, () => 'x') }).success).toBe(false);
    expect(AgentEventSchema.parse({ ...events[3], arguments: { secret: 'discard' } })).toEqual(events[3]);
  });

  it('leaves unavailable usage counters absent and rejects invented or invalid counters', () => {
    expect(AgentEventSchema.parse({ kind: 'usage', inputTokens: 3, seq: 1, at })).toEqual({ kind: 'usage', inputTokens: 3, seq: 1, at });
    expect(AgentEventSchema.safeParse({ kind: 'usage', seq: 1, at }).success).toBe(false);
    expect(AgentEventSchema.safeParse({ ...events[6], inputTokens: -1 }).success).toBe(false);
    expect(AgentEventSchema.safeParse({ ...events[6], contextTokens: 1.5 }).success).toBe(false);
  });

  it('requires nonempty bounded batches with increasing, unique session sequences', () => {
    expect(AgentEventBatchSchema.parse(events)).toEqual(events);
    expect(AgentEventBatchSchema.safeParse([]).success).toBe(false);
    expect(AgentEventBatchSchema.safeParse([events[1], events[0]]).success).toBe(false);
    expect(AgentEventBatchSchema.safeParse([events[0], events[0]]).success).toBe(false);
    const batch = Array.from({ length: MAX_AGENT_EVENT_BATCH }, (_, i) => ({ ...events[0], seq: i + 1 }));
    expect(AgentEventBatchSchema.safeParse(batch).success).toBe(true);
    expect(AgentEventBatchSchema.safeParse([...batch, { ...events[0], seq: 101 }]).success).toBe(false);
    // Gaps are valid after replay filtering; timestamps do not define order.
    expect(AgentEventBatchSchema.safeParse([events[0], { ...events[1], seq: 10, at: 0 }]).success).toBe(true);
  });
});

describe('adapter registry and optional reports', () => {
  const configs = [
    { type: 'claude-code' }, { type: 'codex' }, { type: 'pi' }, { type: 'omp' },
    { type: 'opencode', baseUrl: 'http://localhost:4096', providerID: 'p', modelID: 'm' },
    { type: 'kilo' },
    { type: 'custom', profiles: {
      author: { command: 'agent', args: ['--write', '{prompt}'] },
      reviewer: { command: 'agent', args: ['--read-only', '{prompt}'] },
      directive: { command: 'agent', args: ['--read-only', '{prompt}'] },
    }, sessionIdPath: 'session.id', eventTypePath: 'type', mapping: {
      text: { event: 'text', text: 'text', mode: 'final' }, turn_end: { event: 'done' },
    } },
    { type: 'mock', scriptPath: 'mock.json' },
  ];

  it('keeps the registry, config variants and hello identifiers aligned', () => {
    expect(configs.map((config) => config.type)).toEqual([...ADAPTER_TYPES]);
    for (const config of configs) {
      expect(AdapterConfigSchema.parse(config)).toEqual({ ...config, contextWindow: 200000 });
      expect(AdapterTypeSchema.parse(config.type)).toBe(config.type);
      expect(HelloFrameSchema.parse({ ...hello, adapterType: config.type }).adapterType).toBe(config.type);
    }
    expect(AdapterConfigSchema.safeParse({ type: 'unknown' }).success).toBe(false);
  });

  it.each(['codex', 'pi', 'omp', 'kilo'])('accepts optional binary and model for %s', (type) => {
    const config = { type, binaryPath: '/opt/bin/agent', model: 'custom', contextWindow: 32000 };
    expect(AdapterConfigSchema.parse(config)).toEqual(config);
    expect(AdapterConfigSchema.safeParse({ type, binaryPath: '' }).success).toBe(false);
    expect(AdapterConfigSchema.safeParse({ type, contextWindow: 0 }).success).toBe(false);
  });

  it('preserves old config defaults without adding a user-settable trust assertion', () => {
    const config = parseNodeConfig({
      leaderUrl: 'ws://localhost/ws/node', agentId: 'alice', token: 'qrm_x', ownerName: 'Alice',
      repoRemoteUrl: '/repo', gitIdentity: { name: 'Alice', email: 'a@example.com' },
      adapter: { type: 'claude-code', trust: 'enforced' },
    });
    expect(config.adapter).toEqual({ type: 'claude-code', contextWindow: 200000 });
    expect(config.maxSessions).toBe(2);
  });

  it('accepts old hello/status and new discovery and active-agent trust', () => {
    expect(HelloFrameSchema.parse(hello)).toEqual(hello);
    expect(NodeStatusSchema.parse(status)).toEqual(status);
    const report = { detectedAgents: [detected], trust: 'low' as const };
    expect(HelloFrameSchema.parse({ ...hello, ...report })).toEqual({ ...hello, ...report });
    expect(parseNodeToLeaderFrame(encodeFrame({ kind: 'heartbeat', status: { ...status, ...report } })).ok).toBe(true);
    for (const trust of ['enforced', 'sandboxed', 'low']) expect(DetectedAgentSchema.safeParse({ ...detected, trust }).success).toBe(true);
    expect(DetectedAgentSchema.safeParse({ ...detected, trust: 'trusted' }).success).toBe(false);
    expect(AgentViewSchema.shape.trust.isOptional()).toBe(true);
    expect(AgentViewSchema.shape.adapterType.isOptional()).toBe(true);
  });

  it('keeps local binary paths out of discovery reports on every wire surface', () => {
    const localDetected = { ...detected, path: '/Users/alice/.local/bin/codex' };
    expect(DetectedAgentSchema.shape).not.toHaveProperty('path');
    expect(DetectedAgentSchema.parse(localDetected)).toEqual(detected);
    const report = { detectedAgents: [localDetected] };
    expect(HelloFrameSchema.parse({ ...hello, ...report }).detectedAgents).toEqual([detected]);
    expect(NodeStatusSchema.parse({ ...status, ...report }).detectedAgents).toEqual([detected]);
    expect(AgentViewSchema.shape.detectedAgents.parse(report.detectedAgents)).toEqual([detected]);
  });
});

describe('transcript transport and REST', () => {
  const frame: TranscriptFrame = { kind: 'transcript', msgId: 'm1', sid: 's1', taskId: 7, events };

  it('round-trips a reliable Node-only batch through the public frame helpers', () => {
    expect(parseNodeToLeaderFrame(encodeFrame(frame))).toEqual({ ok: true, frame });
    expect(parseLeaderToNodeFrame(encodeFrame(frame)).ok).toBe(false);
    for (const patch of [{ sid: '' }, { taskId: 0 }, { msgId: '' }, { events: [] }, { events: [...events].reverse() }]) {
      expect(parseNodeToLeaderFrame(JSON.stringify({ ...frame, ...patch })).ok).toBe(false);
    }
  });

  it('adds identity and profile to UI batches using the existing type/data envelope', () => {
    const { kind: _kind, msgId: _msgId, ...batch } = frame;
    const data = { ...batch, agentId: 'alice', profile: 'reviewer' };
    expect(UiEventSchema.parse({ type: 'transcript.appended', data })).toEqual({ type: 'transcript.appended', data });
    expect(UiEventSchema.safeParse({ type: 'transcript.appended', data: batch }).success).toBe(false);
    expect(UiEventSchema.safeParse({ type: 'transcript.appended', data: { ...data, profile: 'human' } }).success).toBe(false);
  });

  it('defines the shared route and grouped response type', () => {
    expect(apiPath('getTaskTranscript', 7)).toBe('/api/tasks/7/transcript');
    expect(API_ROUTES.getTaskTranscript).toMatchObject({ method: 'GET', auth: 'any', status: 200, requesterToken: true, ownerToken: true });
    const response: ApiResponse<'getTaskTranscript'> = { sessions: [
      { sid: 's1', agentId: 'alice', profile: 'author', events },
      { sid: 's2', agentId: 'bob', profile: 'reviewer', events: [] },
    ] };
    expect(TaskTranscriptResponseSchema.parse(response)).toEqual(response);
    expect(TaskTranscriptResponseSchema.parse({ sessions: [] })).toEqual({ sessions: [] });
    expect(TaskTranscriptResponseSchema.safeParse({ sessions: [{ sid: 's1', events }] }).success).toBe(false);
  });

  it('parses an exclusive per-session query cursor without permissive number coercion', () => {
    expect(TaskTranscriptQuerySchema.parse({})).toEqual({});
    expect(TaskTranscriptQuerySchema.parse({ sid: 's1' })).toEqual({ sid: 's1' });
    expect(TaskTranscriptQuerySchema.parse({ afterSeq: '12', sid: 's1' })).toEqual({ afterSeq: 12, sid: 's1' });
    expect(TaskTranscriptQuerySchema.safeParse({ afterSeq: '0' }).success).toBe(false);
    expect(TaskTranscriptQuerySchema.safeParse({ afterSeq: '12' }).success).toBe(false);
    for (const afterSeq of ['', '-1', '1.5', '1e3', ' 1', '01', 'NaN', 'Infinity', '9007199254740992', ['1'], 1]) {
      expect(TaskTranscriptQuerySchema.safeParse({ afterSeq, sid: 's1' }).success).toBe(false);
    }
  });
});

describe('wire compatibility', () => {
  // Frozen v1 field shapes. These intentionally do not import the new Hello/Welcome schemas.
  const legacyHello = z.object({
    kind: z.literal('hello'), agentId: z.string().min(1), token: z.string().min(1), nodeVersion: z.string(),
    protocolVersion: z.number().int().positive(), settings: OwnerSettingsSchema, sessions: z.array(SessionReportSchema),
    adapterType: z.enum(['claude-code', 'opencode', 'mock']),
  });
  const legacyWelcome = z.object({
    kind: z.literal('welcome'), serverTime: z.number().int(), heartbeatIntervalSec: z.number().int().positive(),
    resendUnackedSec: z.number().int().positive(), turnTimeoutSec: z.number().int().positive(), mainBranch: z.string().min(1),
  });
  const welcome = { kind: 'welcome' as const, serverTime: at, heartbeatIntervalSec: 10, resendUnackedSec: 10, turnTimeoutSec: 1800, mainBranch: 'main' };

  it('keeps v1 and lets older peers strip optional additions on existing frames', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(legacyHello.parse({ ...hello, trust: 'low', detectedAgents: [detected] })).toEqual(hello);
    expect(WelcomeFrameSchema.parse(welcome)).toEqual(welcome);
    expect(legacyWelcome.parse({ ...welcome, capabilities: ['transcript-v1'] })).toEqual(welcome);
    expect(WelcomeFrameSchema.parse({ ...welcome, capabilities: ['transcript-v1'] }).capabilities).toEqual(['transcript-v1']);
    expect(WelcomeFrameSchema.parse({ ...welcome, capabilities: ['future-capability'] }).capabilities).toEqual(['future-capability']);
  });

  it('makes the old closed-enum boundary explicit; new adapter names require an upgraded Leader', () => {
    expect(legacyHello.safeParse({ ...hello, adapterType: 'codex' }).success).toBe(false);
    expect(HelloFrameSchema.safeParse({ ...hello, adapterType: 'codex' }).success).toBe(true);
    // An omitted capability never authorizes a new frame kind to an old Leader.
    expect(WelcomeFrameSchema.parse(welcome).capabilities).toBeUndefined();
  });
});

describe('owner API tokens', () => {
  const token = { id: 't1', agentId: 'alice', scope: 'requester', label: 'cli', createdAt: at, lastUsedAt: null, revokedAt: null };

  it('preserves old mint requests and requester views and accepts the owner scope', () => {
    expect(CreateApiTokenRequestSchema.parse({})).toEqual({});
    expect(CreateApiTokenRequestSchema.parse({ label: ' cli ' })).toEqual({ label: 'cli' });
    expect(ApiTokenViewSchema.parse(token)).toEqual(token);
    expect(ApiTokenViewSchema.parse({ ...token, scope: 'owner' }).scope).toBe('owner');
    expect(CreateApiTokenRequestSchema.parse({ scope: 'owner' })).toEqual({ scope: 'owner' });
    expect(TokenScopeSchema.parse('full')).toBe('full');
    expect(TokenScopeSchema.parse('requester')).toBe('requester');
    expect(TokenScopeSchema.parse('owner')).toBe('owner');
  });

  it('never mints or projects full agent credentials as API tokens', () => {
    expect(CreateApiTokenRequestSchema.safeParse({ scope: 'full' }).success).toBe(false);
    expect(ApiTokenViewSchema.safeParse({ ...token, scope: 'full' }).success).toBe(false);
  });

  it('marks owner actions without granting requester actions or token management', () => {
    for (const name of ['approveTask', 'sendBackTask', 'pauseTask', 'cancelTask', 'resumeTask', 'reassignReviewer'] as const) {
      const route = API_ROUTES[name];
      expect(route.auth).toBe('requesterOrAdmin');
      expect(route.ownerToken).toBe(true);
      expect('requesterToken' in route).toBe(false);
    }
    for (const name of ['createApiToken', 'listApiTokens', 'revokeApiToken'] as const) {
      expect('ownerToken' in API_ROUTES[name]).toBe(false);
      expect('requesterToken' in API_ROUTES[name]).toBe(false);
    }
  });
});
