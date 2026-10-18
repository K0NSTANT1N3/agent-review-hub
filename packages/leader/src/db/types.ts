export interface AgentRow {
  id: string;
  owner_name: string;
  token_hash: string;
  revoked: number;
  status: string;
  last_heartbeat_at: number | null;
  max_sessions: number;
  lend_mode: string;
  lend_tokens_per_day: number;
  human_idle_sec: number | null;
  paused: number;
  tags: string;
  context_window: number;
  rate_limited_until: number | null;
  cost_ratio_ema: number;
  last_assigned_at: number | null;
  created_at: number;
}

export interface SessionRow {
  id: string;
  agent_id: string;
  state: string;
  lock_kind: string | null;
  lock_ref: string | null;
  lock_role: string | null;
  lease_expires_at: number | null;
  context_tokens: number;
  files: string;
  task_history: string;
  created_at: number;
  last_used_at: number;
  closed_at: number | null;
}

export interface TaskRow {
  id: number;
  title: string;
  description: string;
  tags: string;
  priority: number;
  mode: string;
  requester_agent_id: string;
  author_agent_id: string | null;
  author_session_id: string | null;
  state: string;
  paused_from_state: string | null;
  pause_reason: string | null;
  escalation_reason: string | null;
  branch: string | null;
  base_commit: string | null;
  head_commit: string | null;
  last_reviewed_commit: string | null;
  review_round: number;
  test_fix_attempts: number;
  sync_attempts: number;
  turn_retries: number;
  sync_had_conflicts: number;
  files: string;
  diff_lines: number;
  last_test_output: string | null;
  merged_commit: string | null;
  created_at: number;
  updated_at: number;
  state_entered_at: number;
  approved_at: number | null;
}

export interface ConversationRow {
  id: string;
  task_id: number;
  author_session_id: string;
  author_agent_id: string;
  reviewer_session_id: string;
  reviewer_agent_id: string;
  state: string;
  next_seq: number;
  created_at: number;
  ended_at: number | null;
}

export interface IssueRow {
  id: number;
  task_id: number;
  code: string;
  source: string;
  severity: string;
  file: string | null;
  line: number | null;
  comment: string;
  status: string;
  author_response: string | null;
  author_note: string | null;
  dispute_count: number;
  raised_round: number;
  conversation_id: string | null;
  created_at: number;
}

export interface MessageRow {
  id: string;
  direction: string;
  agent_id: string;
  session_id: string | null;
  task_id: number | null;
  directive_id: string | null;
  conversation_id: string | null;
  seq: number | null;
  type: string;
  payload: string;
  created_at: number;
  sent_at: number | null;
  acked_at: number | null;
}

export interface TaskEventRow {
  id: number;
  task_id: number;
  from_state: string | null;
  to_state: string;
  reason: string;
  actor: string;
  data: string;
  at: number;
}

export interface UsageRow {
  id: number;
  agent_id: string;
  session_id: string | null;
  task_id: number | null;
  directive_id: string | null;
  kind: string;
  role: string;
  input_tokens: number;
  output_tokens: number;
  estimated: number | null;
  at: number;
}

export interface DirectiveRow {
  id: string;
  requester: string;
  agent_id: string;
  session_id: string | null;
  text: string;
  state: string;
  result_text: string | null;
  error: string | null;
  created_at: number;
  finished_at: number | null;
}

export interface MergeQueueRow {
  task_id: number;
  enqueued_at: number;
}

export interface Tables {
  agents: AgentRow;
  sessions: SessionRow;
  tasks: TaskRow;
  conversations: ConversationRow;
  issues: IssueRow;
  messages: MessageRow;
  task_events: TaskEventRow;
  usage_ledger: UsageRow;
  directives: DirectiveRow;
  merge_queue: MergeQueueRow;
}

type InsertWith<R, K extends keyof R> = Pick<R, K> & Partial<Omit<R, K>>;

export interface Inserts {
  agents: InsertWith<AgentRow, 'id' | 'owner_name' | 'token_hash' | 'created_at'>;
  sessions: InsertWith<SessionRow, 'id' | 'agent_id' | 'state' | 'created_at' | 'last_used_at'>;
  tasks: InsertWith<TaskRow, 'title' | 'description' | 'requester_agent_id' | 'state' | 'created_at' | 'updated_at' | 'state_entered_at'>;
  conversations: InsertWith<ConversationRow, 'id' | 'task_id' | 'author_session_id' | 'author_agent_id' | 'reviewer_session_id' | 'reviewer_agent_id' | 'state' | 'created_at'>;
  issues: InsertWith<IssueRow, 'task_id' | 'code' | 'source' | 'severity' | 'comment' | 'status' | 'raised_round' | 'created_at'>;
  messages: InsertWith<MessageRow, 'id' | 'direction' | 'agent_id' | 'type' | 'payload' | 'created_at'>;
  task_events: InsertWith<TaskEventRow, 'task_id' | 'to_state' | 'reason' | 'actor' | 'at'>;
  usage_ledger: InsertWith<UsageRow, 'agent_id' | 'kind' | 'role' | 'input_tokens' | 'output_tokens' | 'at'>;
  directives: InsertWith<DirectiveRow, 'id' | 'requester' | 'agent_id' | 'text' | 'state' | 'created_at'>;
  merge_queue: MergeQueueRow;
}

export type KeyColumn<N extends keyof Tables> = N extends 'merge_queue' ? 'task_id' : 'id';
export type RowKey<N extends keyof Tables> = Tables[N][KeyColumn<N> & keyof Tables[N]] & (string | number);
export type Patch<N extends keyof Tables> = Partial<Omit<Tables[N],
  N extends 'conversations'
    ? 'id' | 'task_id' | 'author_session_id' | 'author_agent_id' | 'reviewer_session_id' | 'reviewer_agent_id' | 'created_at'
    : KeyColumn<N>>>;
