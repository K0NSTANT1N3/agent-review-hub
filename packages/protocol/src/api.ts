import { z } from 'zod';
import { LendModeSchema } from './config.js';
import {
  AgentStatusSchema,
  AuthorActionSchema,
  ConversationStateSchema,
  DirectiveStateSchema,
  IssueSeveritySchema,
  IssueSourceSchema,
  IssueStatusSchema,
  LockKindSchema,
  LockRoleSchema,
  SessionStateSchema,
  TaskModeSchema,
  TaskPrioritySchema,
  TaskStateSchema,
} from './common.js';

// Leader REST API (/api/*) and UI WebSocket (/ws/ui) — spec §17.
// Views are camelCase projections of the §7 tables; JSON columns are decoded.

const ts = z.number().int();
const nullableTs = ts.nullable();

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export const AgentViewSchema = z.object({
  id: z.string(),
  ownerName: z.string(),
  status: AgentStatusSchema,
  lastHeartbeatAt: nullableTs,
  maxSessions: z.number().int(),
  lendMode: LendModeSchema,
  lendTokensPerDay: z.number().int(),
  humanIdleSec: z.number().nullable(),
  paused: z.boolean(),
  tags: z.array(z.string()),
  contextWindow: z.number().int(),
  rateLimitedUntil: nullableTs,
  lockedSessions: z.number().int(),
  idleSessions: z.number().int(),
  lentToday: z.number().int(),
  budgetRemaining: z.number().int(),
});
export type AgentView = z.infer<typeof AgentViewSchema>;

export const SessionViewSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  state: SessionStateSchema,
  lockKind: LockKindSchema.nullable(),
  lockRef: z.string().nullable(),
  lockRole: LockRoleSchema.nullable(),
  leaseExpiresAt: nullableTs,
  contextTokens: z.number().int(),
  files: z.array(z.string()),
  taskHistory: z.array(z.number().int()),
  createdAt: ts,
  lastUsedAt: ts,
  closedAt: nullableTs,
});
export type SessionView = z.infer<typeof SessionViewSchema>;

export const TaskViewSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  priority: TaskPrioritySchema,
  mode: TaskModeSchema,
  requesterAgentId: z.string(),
  requesterOwner: z.string(),
  authorAgentId: z.string().nullable(),
  authorSessionId: z.string().nullable(),
  state: TaskStateSchema,
  pausedFromState: TaskStateSchema.nullable(),
  pauseReason: z.string().nullable(),
  escalationReason: z.string().nullable(),
  branch: z.string().nullable(),
  baseCommit: z.string().nullable(),
  headCommit: z.string().nullable(),
  lastReviewedCommit: z.string().nullable(),
  reviewRound: z.number().int(),
  testFixAttempts: z.number().int(),
  syncAttempts: z.number().int(),
  files: z.array(z.string()),
  diffLines: z.number().int(),
  lastTestOutput: z.string().nullable(),
  mergedCommit: z.string().nullable(),
  createdAt: ts,
  updatedAt: ts,
  stateEnteredAt: ts,
  approvedAt: nullableTs,
});
export type TaskView = z.infer<typeof TaskViewSchema>;

export const ConversationViewSchema = z.object({
  id: z.string(),
  taskId: z.number().int(),
  authorSessionId: z.string(),
  authorAgentId: z.string(),
  reviewerSessionId: z.string(),
  reviewerAgentId: z.string(),
  state: ConversationStateSchema,
  createdAt: ts,
  endedAt: nullableTs,
});
export type ConversationView = z.infer<typeof ConversationViewSchema>;

export const IssueViewSchema = z.object({
  id: z.number().int(),
  taskId: z.number().int(),
  code: z.string(),
  source: IssueSourceSchema,
  severity: IssueSeveritySchema,
  file: z.string().nullable(),
  line: z.number().int().nullable(),
  comment: z.string(),
  status: IssueStatusSchema,
  authorResponse: AuthorActionSchema.nullable(),
  authorNote: z.string().nullable(),
  disputeCount: z.number().int(),
  raisedRound: z.number().int(),
  conversationId: z.string().nullable(),
  createdAt: ts,
});
export type IssueView = z.infer<typeof IssueViewSchema>;

export const TaskEventViewSchema = z.object({
  id: z.number().int(),
  taskId: z.number().int(),
  fromState: TaskStateSchema.nullable(),
  toState: TaskStateSchema,
  reason: z.string(),
  actor: z.string(),
  data: z.record(z.string(), z.unknown()),
  at: ts,
});
export type TaskEventView = z.infer<typeof TaskEventViewSchema>;

export const MessageViewSchema = z.object({
  id: z.string(),
  direction: z.enum(['to_node', 'from_node']),
  agentId: z.string(),
  sessionId: z.string().nullable(),
  taskId: z.number().int().nullable(),
  directiveId: z.string().nullable(),
  conversationId: z.string().nullable(),
  seq: z.number().int().nullable(),
  /** Command or event type, e.g. 'review.rereview'. */
  type: z.string(),
  /** The Command (to_node) or Event (from_node) object itself — not the {kind,msgId,…} frame. */
  payload: z.unknown(),
  createdAt: ts,
  sentAt: nullableTs,
  ackedAt: nullableTs,
});
export type MessageView = z.infer<typeof MessageViewSchema>;

export const TaskDetailSchema = z.object({
  task: TaskViewSchema,
  conversations: z.array(ConversationViewSchema),
  issues: z.array(IssueViewSchema),
  events: z.array(TaskEventViewSchema),
  messages: z.array(MessageViewSchema),
});
export type TaskDetail = z.infer<typeof TaskDetailSchema>;

export const DirectiveViewSchema = z.object({
  id: z.string(),
  requester: z.string(),
  agentId: z.string(),
  sessionId: z.string().nullable(),
  text: z.string(),
  state: DirectiveStateSchema,
  resultText: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: ts,
  finishedAt: nullableTs,
});
export type DirectiveView = z.infer<typeof DirectiveViewSchema>;

// ---------------------------------------------------------------------------
// Requests / responses
// ---------------------------------------------------------------------------

export const ListAgentsResponseSchema = z.object({ agents: z.array(AgentViewSchema) });
export type ListAgentsResponse = z.infer<typeof ListAgentsResponseSchema>;

export const ListSessionsQuerySchema = z.object({ agentId: z.string().optional() });
export const ListSessionsResponseSchema = z.object({ sessions: z.array(SessionViewSchema) });
export type ListSessionsResponse = z.infer<typeof ListSessionsResponseSchema>;

export const ListTasksQuerySchema = z.object({
  state: TaskStateSchema.optional(),
  /** "true" → only tasks requested by the caller's agent. */
  mine: z.enum(['true', 'false']).optional(),
});
export const ListTasksResponseSchema = z.object({ tasks: z.array(TaskViewSchema) });
export type ListTasksResponse = z.infer<typeof ListTasksResponseSchema>;

export const CreateTaskRequestSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().min(1),
  tags: z.array(z.string()).default([]),
  priority: TaskPrioritySchema.default(1),
  mode: TaskModeSchema.default('own'),
});
export type CreateTaskRequest = z.input<typeof CreateTaskRequestSchema>;

export const PatchTaskRequestSchema = z
  .object({
    priority: TaskPrioritySchema.optional(),
    tags: z.array(z.string()).optional(),
    mode: TaskModeSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required' });
export type PatchTaskRequest = z.infer<typeof PatchTaskRequestSchema>;

export const SendBackRequestSchema = z.object({ comment: z.string().min(1) });
export type SendBackRequest = z.infer<typeof SendBackRequestSchema>;

export const DiffQuerySchema = z.object({ from: z.string().optional(), to: z.string().optional() });
export const DiffResponseSchema = z.object({ from: z.string(), to: z.string(), diff: z.string() });
export type DiffResponse = z.infer<typeof DiffResponseSchema>;

export const CreateDirectiveRequestSchema = z.object({
  agentId: z.string().min(1),
  text: z.string().min(1),
  sessionId: z.string().min(1).optional(),
});
export type CreateDirectiveRequest = z.infer<typeof CreateDirectiveRequestSchema>;

export const HealthResponseSchema = z.object({ ok: z.literal(true) });

export const ApiErrorCodeSchema = z.enum([
  'VALIDATION',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'ILLEGAL_TRANSITION',
  'SESSION_LOCKED',
  'CONFLICT',
  'INTERNAL',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorSchema = z.object({ error: ApiErrorCodeSchema, message: z.string() });
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const API_ERROR_HTTP_STATUS: Record<ApiErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  ILLEGAL_TRANSITION: 409,
  SESSION_LOCKED: 409,
  CONFLICT: 409,
  INTERNAL: 500,
};

// ---------------------------------------------------------------------------
// Route table — the single source of truth for server (L8) and clients (desktop, e2e)
// ---------------------------------------------------------------------------

export type HttpMethod = 'GET' | 'POST' | 'PATCH';
export type RoutePermission = 'none' | 'any' | 'requesterOrAdmin';

export interface RouteDef {
  method: HttpMethod;
  /** Fastify-style path; `:id` is the task or directive id. */
  path: string;
  auth: RoutePermission;
  /** HTTP status on success. */
  status: 200 | 201;
  query?: z.ZodType;
  body?: z.ZodType;
  response: z.ZodType;
}

const TaskActionBodySchema = z.object({}).strict().optional();

export const API_ROUTES = {
  health: { method: 'GET', path: '/api/health', auth: 'none', status: 200, response: HealthResponseSchema },
  listAgents: { method: 'GET', path: '/api/agents', auth: 'any', status: 200, response: ListAgentsResponseSchema },
  listSessions: {
    method: 'GET',
    path: '/api/sessions',
    auth: 'any',
    status: 200,
    query: ListSessionsQuerySchema,
    response: ListSessionsResponseSchema,
  },
  listTasks: { method: 'GET', path: '/api/tasks', auth: 'any', status: 200, query: ListTasksQuerySchema, response: ListTasksResponseSchema },
  createTask: { method: 'POST', path: '/api/tasks', auth: 'any', status: 201, body: CreateTaskRequestSchema, response: TaskViewSchema },
  getTask: { method: 'GET', path: '/api/tasks/:id', auth: 'any', status: 200, response: TaskDetailSchema },
  getTaskDiff: { method: 'GET', path: '/api/tasks/:id/diff', auth: 'any', status: 200, query: DiffQuerySchema, response: DiffResponseSchema },
  patchTask: { method: 'PATCH', path: '/api/tasks/:id', auth: 'requesterOrAdmin', status: 200, body: PatchTaskRequestSchema, response: TaskViewSchema },
  cancelTask: { method: 'POST', path: '/api/tasks/:id/cancel', auth: 'requesterOrAdmin', status: 200, body: TaskActionBodySchema, response: TaskViewSchema },
  approveTask: { method: 'POST', path: '/api/tasks/:id/approve', auth: 'requesterOrAdmin', status: 200, body: TaskActionBodySchema, response: TaskViewSchema },
  sendBackTask: { method: 'POST', path: '/api/tasks/:id/send-back', auth: 'requesterOrAdmin', status: 200, body: SendBackRequestSchema, response: TaskViewSchema },
  reassignReviewer: {
    method: 'POST',
    path: '/api/tasks/:id/reassign-reviewer',
    auth: 'requesterOrAdmin',
    status: 200,
    body: TaskActionBodySchema,
    response: TaskViewSchema,
  },
  pauseTask: { method: 'POST', path: '/api/tasks/:id/pause', auth: 'requesterOrAdmin', status: 200, body: TaskActionBodySchema, response: TaskViewSchema },
  resumeTask: { method: 'POST', path: '/api/tasks/:id/resume', auth: 'requesterOrAdmin', status: 200, body: TaskActionBodySchema, response: TaskViewSchema },
  createDirective: { method: 'POST', path: '/api/directives', auth: 'any', status: 201, body: CreateDirectiveRequestSchema, response: DirectiveViewSchema },
  getDirective: { method: 'GET', path: '/api/directives/:id', auth: 'any', status: 200, response: DirectiveViewSchema },
} as const satisfies Record<string, RouteDef>;

export type ApiRouteName = keyof typeof API_ROUTES;
export type ApiResponse<R extends ApiRouteName> = z.infer<(typeof API_ROUTES)[R]['response']>;

/** Fills `:id` in a route path. */
export function apiPath(route: ApiRouteName, id?: number | string): string {
  const path: string = API_ROUTES[route].path;
  if (!path.includes(':id')) return path;
  if (id === undefined) throw new Error(`route ${route} requires an id`);
  return path.replace(':id', encodeURIComponent(String(id)));
}

/** UI WebSocket path; authenticate with `?token=<agent token>`. */
export const UI_WS_PATH = '/ws/ui';
/** Node WebSocket path. */
export const NODE_WS_PATH = '/ws/node';

// ---------------------------------------------------------------------------
// UI WebSocket push events (/ws/ui)
// ---------------------------------------------------------------------------

export const NeedsAttentionReasonSchema = z.enum(['no_reviewer', 'author_unavailable', 'escalated']);

export const UiEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('task.updated'), data: TaskViewSchema }),
  z.object({ type: z.literal('task.event'), data: TaskEventViewSchema }),
  z.object({ type: z.literal('agent.updated'), data: AgentViewSchema }),
  z.object({ type: z.literal('session.updated'), data: SessionViewSchema }),
  z.object({ type: z.literal('message.created'), data: MessageViewSchema }),
  z.object({ type: z.literal('directive.updated'), data: DirectiveViewSchema }),
  z.object({
    type: z.literal('task.needs_attention'),
    data: z.object({ taskId: z.number().int(), reason: NeedsAttentionReasonSchema, message: z.string() }),
  }),
]);
export type UiEvent = z.infer<typeof UiEventSchema>;
export type UiEventType = UiEvent['type'];
