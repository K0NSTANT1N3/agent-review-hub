PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE agents (
  id                   TEXT PRIMARY KEY,           -- e.g. 'alice-claude'
  owner_name           TEXT NOT NULL,
  token_hash           TEXT NOT NULL,              -- sha256 of token
  revoked              INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'offline',  -- 'online' | 'offline'
  last_heartbeat_at    INTEGER,
  max_sessions         INTEGER NOT NULL DEFAULT 2,
  lend_mode            TEXT NOT NULL DEFAULT 'never',
  lend_tokens_per_day  INTEGER NOT NULL DEFAULT 0,
  human_idle_sec       INTEGER,                    -- null = unknown
  paused               INTEGER NOT NULL DEFAULT 0,
  tags                 TEXT NOT NULL DEFAULT '[]',
  context_window       INTEGER NOT NULL DEFAULT 200000,
  rate_limited_until   INTEGER,
  cost_ratio_ema       REAL NOT NULL DEFAULT 1.0,  -- actual/estimated tokens
  last_assigned_at     INTEGER,
  created_at           INTEGER NOT NULL
);

CREATE TABLE sessions (
  id                TEXT PRIMARY KEY,               -- sid
  agent_id          TEXT NOT NULL REFERENCES agents(id),
  state             TEXT NOT NULL,                  -- 'opening'|'idle'|'locked'|'closing'|'closed'|'lost'
  profile           TEXT,                           -- 'author'|'reviewer'|'directive'; a session only ever serves its own profile
  lock_kind         TEXT,                           -- null | 'task' | 'directive'
  lock_ref          TEXT,                           -- task id or directive id (as text)
  lock_role         TEXT,                           -- null | 'author' | 'reviewer' | 'directive'
  lease_expires_at  INTEGER,
  context_tokens    INTEGER NOT NULL DEFAULT 0,
  files             TEXT NOT NULL DEFAULT '[]',     -- union of repo paths this session has worked on
  task_history      TEXT NOT NULL DEFAULT '[]',     -- task ids
  created_at        INTEGER NOT NULL,
  last_used_at      INTEGER NOT NULL,
  closed_at         INTEGER,
  CHECK ((lock_kind IS NULL) = (lock_ref IS NULL)),
  CHECK ((state = 'locked') = (lock_kind IS NOT NULL))
);
CREATE INDEX sessions_agent_state ON sessions(agent_id, state);
CREATE INDEX sessions_lock ON sessions(lock_kind, lock_ref);

CREATE TABLE tasks (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  title                  TEXT NOT NULL,
  description            TEXT NOT NULL,
  tags                   TEXT NOT NULL DEFAULT '[]',
  priority               INTEGER NOT NULL DEFAULT 1,     -- 0 low, 1 normal, 2 high, 3 urgent
  mode                   TEXT NOT NULL DEFAULT 'own',    -- 'own' | 'pool'
  requester_agent_id     TEXT NOT NULL REFERENCES agents(id),
  author_agent_id        TEXT REFERENCES agents(id),
  author_session_id      TEXT REFERENCES sessions(id),
  state                  TEXT NOT NULL,
  paused_from_state      TEXT,
  pause_reason           TEXT,
  escalation_reason      TEXT,
  branch                 TEXT,
  base_commit            TEXT,
  head_commit            TEXT,
  last_reviewed_commit   TEXT,
  review_round           INTEGER NOT NULL DEFAULT 0,
  test_fix_attempts      INTEGER NOT NULL DEFAULT 0,
  sync_attempts          INTEGER NOT NULL DEFAULT 0,
  turn_retries           INTEGER NOT NULL DEFAULT 0,
  sync_had_conflicts     INTEGER NOT NULL DEFAULT 0,
  files                  TEXT NOT NULL DEFAULT '[]',
  diff_lines             INTEGER NOT NULL DEFAULT 0,
  last_test_output       TEXT,
  merged_commit          TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  state_entered_at       INTEGER NOT NULL,
  approved_at            INTEGER
);
CREATE INDEX tasks_state ON tasks(state);

CREATE TABLE conversations (
  id                   TEXT PRIMARY KEY,
  task_id              INTEGER NOT NULL REFERENCES tasks(id),
  author_session_id    TEXT NOT NULL REFERENCES sessions(id),
  author_agent_id      TEXT NOT NULL REFERENCES agents(id),
  reviewer_session_id  TEXT NOT NULL REFERENCES sessions(id),
  reviewer_agent_id    TEXT NOT NULL REFERENCES agents(id),
  state                TEXT NOT NULL,              -- 'active' | 'closed' | 'abandoned'
  next_seq             INTEGER NOT NULL DEFAULT 1,
  created_at           INTEGER NOT NULL,
  ended_at             INTEGER,
  CHECK (author_agent_id <> reviewer_agent_id)
);
CREATE UNIQUE INDEX one_active_conversation_per_task
  ON conversations(task_id) WHERE state = 'active';

CREATE TABLE issues (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id          INTEGER NOT NULL REFERENCES tasks(id),
  code             TEXT NOT NULL,                 -- 'I1', 'I2', … unique per task
  source           TEXT NOT NULL,                 -- 'reviewer' | 'human' | 'system'
  severity         TEXT NOT NULL,                 -- 'blocking' | 'suggestion'
  file             TEXT,
  line             INTEGER,
  comment          TEXT NOT NULL,
  status           TEXT NOT NULL,                 -- 'open' | 'resolved' | 'closed_by_human'
  author_response  TEXT,                          -- last: 'fixed' | 'disputed' | 'wontfix'
  author_note      TEXT,
  dispute_count    INTEGER NOT NULL DEFAULT 0,
  raised_round     INTEGER NOT NULL,
  conversation_id  TEXT REFERENCES conversations(id),
  created_at       INTEGER NOT NULL,
  UNIQUE (task_id, code)
);

CREATE TABLE messages (                          -- outbox + inbox + conversation transcript
  id               TEXT PRIMARY KEY,              -- msgId
  direction        TEXT NOT NULL,                 -- 'to_node' | 'from_node'
  agent_id         TEXT NOT NULL REFERENCES agents(id),
  session_id       TEXT,
  task_id          INTEGER,
  directive_id     TEXT,
  conversation_id  TEXT,
  seq              INTEGER,                       -- per conversation, set when conversation_id not null
  type             TEXT NOT NULL,                 -- command or event type
  payload          TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  sent_at          INTEGER,
  acked_at         INTEGER,
  UNIQUE (conversation_id, seq)
);
CREATE INDEX messages_unacked ON messages(direction, agent_id, acked_at);

CREATE TABLE task_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id),
  from_state TEXT,
  to_state   TEXT NOT NULL,
  reason     TEXT NOT NULL,
  actor      TEXT NOT NULL,          -- 'leader' | 'agent:<id>' | 'human:<owner>' | 'token:<owner>' (requester API token)
  data       TEXT NOT NULL DEFAULT '{}',
  at         INTEGER NOT NULL
);

CREATE TABLE usage_ledger (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id       TEXT NOT NULL REFERENCES agents(id),
  session_id     TEXT,
  task_id        INTEGER,
  directive_id   TEXT,
  kind           TEXT NOT NULL,       -- 'own' | 'lent'
  role           TEXT NOT NULL,       -- 'author' | 'reviewer' | 'directive' | 'maintenance'
  input_tokens   INTEGER NOT NULL,
  output_tokens  INTEGER NOT NULL,
  estimated      INTEGER,             -- estimate made at assignment, for EMA
  at             INTEGER NOT NULL
);
CREATE INDEX usage_agent_at ON usage_ledger(agent_id, at);

CREATE TABLE directives (
  id               TEXT PRIMARY KEY,
  requester        TEXT NOT NULL,     -- owner name
  agent_id         TEXT NOT NULL REFERENCES agents(id),
  session_id       TEXT REFERENCES sessions(id),
  text             TEXT NOT NULL,
  state            TEXT NOT NULL,     -- 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  result_text      TEXT,
  error            TEXT,
  created_at       INTEGER NOT NULL,
  finished_at      INTEGER
);

CREATE TABLE merge_queue (
  task_id      INTEGER PRIMARY KEY REFERENCES tasks(id),
  enqueued_at  INTEGER NOT NULL
);

CREATE TABLE api_tokens (                        -- extra credentials for scripts and coding agents (quorum CLI)
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL REFERENCES agents(id), -- acts as this agent's owner
  token_hash    TEXT NOT NULL UNIQUE,               -- sha256 of token
  scope         TEXT NOT NULL,                      -- 'requester'
  label         TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  revoked_at    INTEGER
);
CREATE INDEX api_tokens_agent ON api_tokens(agent_id);

-- v3: transcript storage and Node-reported adapter metadata.
ALTER TABLE agents ADD COLUMN trust TEXT;
ALTER TABLE agents ADD COLUMN detected_agents TEXT;
ALTER TABLE sessions ADD COLUMN transcript_seq INTEGER NOT NULL DEFAULT 0;

CREATE TABLE transcript_sessions (
  task_id   INTEGER NOT NULL REFERENCES tasks(id),
  sid       TEXT NOT NULL REFERENCES sessions(id),
  agent_id  TEXT NOT NULL REFERENCES agents(id),
  profile   TEXT NOT NULL,
  PRIMARY KEY (task_id, sid)
);

CREATE TABLE transcript_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id   INTEGER NOT NULL REFERENCES tasks(id),
  sid       TEXT NOT NULL REFERENCES sessions(id),
  agent_id  TEXT NOT NULL REFERENCES agents(id),
  profile   TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  at        INTEGER NOT NULL,
  kind      TEXT NOT NULL,
  payload   TEXT NOT NULL,
  turn_id   TEXT NOT NULL,
  UNIQUE (sid, seq)
);
CREATE INDEX transcript_task_session_seq ON transcript_events(task_id, sid, seq);

-- Receipts contain no event payload, so replay dedupe survives retention.
CREATE TABLE transcript_receipts (
  id        TEXT PRIMARY KEY,
  agent_id  TEXT NOT NULL REFERENCES agents(id)
);
