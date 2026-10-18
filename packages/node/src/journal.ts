import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command, Event } from '@quorum/protocol';

export type InboxState = 'received' | 'running' | 'done';

export interface InboxRecord {
  msgId: string;
  cmd: Command;
  state: InboxState;
  resultEvtMsgId: string | null;
  receivedAt: number;
  finishedAt: number | null;
}

export interface OutboxRecord {
  msgId: string;
  evt: Event;
  createdAt: number;
}

export interface JournalSession {
  sid: string;
  nativeId: string | null;
  worktree: string;
  profile: string | null;
  contextTokens: number;
  state: string;
  createdAt: number;
}

export type NewJournalSession = Omit<JournalSession, 'createdAt'> & { createdAt?: number };
export type SessionPatch = Partial<Pick<JournalSession, 'nativeId' | 'profile' | 'contextTokens' | 'state'>>;

interface InboxRow {
  msg_id: string;
  cmd: string;
  state: InboxState;
  result_evt_msg_id: string | null;
  received_at: number;
  finished_at: number | null;
}

interface OutboxRow {
  msg_id: string;
  evt: string;
  created_at: number;
}

interface SessionRow {
  sid: string;
  native_id: string | null;
  worktree: string;
  profile: string | null;
  context_tokens: number;
  state: string;
  created_at: number;
}

export class NodeJournal {
  private constructor(private readonly db: Database.Database, private readonly now: () => number) {}

  static async open(dataDir: string, now: () => number = Date.now): Promise<NodeJournal> {
    await mkdir(dataDir, { recursive: true });
    const db = new Database(join(dataDir, 'node.db'));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE IF NOT EXISTS inbox (
        msg_id TEXT PRIMARY KEY,
        cmd TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('received', 'running', 'done')),
        result_evt_msg_id TEXT,
        received_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS outbox (
        msg_id TEXT PRIMARY KEY,
        evt TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        acked_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS outbox_unacked_created_at ON outbox(acked_at, created_at);
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        native_id TEXT,
        worktree TEXT NOT NULL,
        profile TEXT,
        context_tokens INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    return new NodeJournal(db, now);
  }

  recordCommand(msgId: string, cmd: Command): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO inbox (msg_id, cmd, state, received_at)
      VALUES (?, ?, 'received', ?)
    `).run(msgId, JSON.stringify(cmd), this.now());
    return result.changes === 1;
  }

  markRunning(msgId: string): void {
    const result = this.db.prepare(`
      UPDATE inbox SET state = 'running' WHERE msg_id = ? AND state = 'received'
    `).run(msgId);
    if (result.changes === 1) return;
    const row = this.db.prepare('SELECT state FROM inbox WHERE msg_id = ?').get(msgId) as { state: InboxState } | undefined;
    if (row?.state === 'running') return;
    if (row?.state === 'done') throw new Error(`Cannot mark completed command ${msgId} as running`);
    throw new Error(`Cannot mark unknown command ${msgId} as running`);
  }

  markDone(msgId: string, resultEvtMsgId: string): void {
    const result = this.db.prepare(`
      UPDATE inbox SET state = 'done', result_evt_msg_id = ?, finished_at = ?
      WHERE msg_id = ? AND state IN ('received', 'running')
    `).run(resultEvtMsgId, this.now(), msgId);
    if (result.changes === 1) return;
    const row = this.db.prepare('SELECT state, result_evt_msg_id FROM inbox WHERE msg_id = ?').get(msgId) as
      { state: InboxState; result_evt_msg_id: string | null } | undefined;
    if (row?.state === 'done' && row.result_evt_msg_id === resultEvtMsgId) return;
    if (!row) throw new Error(`Cannot mark unknown command ${msgId} as done`);
    throw new Error(`Command ${msgId} is already done with a different result event`);
  }

  enqueueEvent(evt: Event): string {
    const msgId = randomUUID();
    this.insertEvent(msgId, evt, this.now());
    return msgId;
  }

  markAcked(msgId: string): void {
    this.db.prepare('UPDATE outbox SET acked_at = COALESCE(acked_at, ?) WHERE msg_id = ?').run(this.now(), msgId);
  }

  unackedEvents(): OutboxRecord[] {
    const rows = this.db.prepare(`
      SELECT msg_id, evt, created_at FROM outbox WHERE acked_at IS NULL ORDER BY created_at, msg_id
    `).all() as OutboxRow[];
    return rows.map((row) => ({
      msgId: row.msg_id,
      evt: JSON.parse(row.evt) as Event,
      createdAt: row.created_at,
    }));
  }

  isProcessed(msgId: string): boolean {
    return this.db.prepare('SELECT 1 AS found FROM inbox WHERE msg_id = ?').get(msgId) !== undefined;
  }

  getCommand(msgId: string): InboxRecord | null {
    const row = this.db.prepare('SELECT * FROM inbox WHERE msg_id = ?').get(msgId) as InboxRow | undefined;
    return row ? mapInbox(row) : null;
  }

  createSession(session: NewJournalSession): JournalSession {
    const createdAt = session.createdAt ?? this.now();
    this.db.prepare(`
      INSERT INTO sessions (sid, native_id, worktree, profile, context_tokens, state, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.sid,
      session.nativeId,
      session.worktree,
      session.profile,
      session.contextTokens,
      session.state,
      createdAt,
    );
    return { ...session, createdAt };
  }

  getSession(sid: string): JournalSession | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE sid = ?').get(sid) as SessionRow | undefined;
    return row ? mapSession(row) : null;
  }

  listSessions(): JournalSession[] {
    const rows = this.db.prepare('SELECT * FROM sessions ORDER BY created_at, sid').all() as SessionRow[];
    return rows.map(mapSession);
  }

  updateSession(sid: string, patch: SessionPatch): boolean {
    const columns: Array<[keyof SessionPatch, string]> = [
      ['nativeId', 'native_id'],
      ['profile', 'profile'],
      ['contextTokens', 'context_tokens'],
      ['state', 'state'],
    ];
    const updates = columns.filter(([key]) => Object.hasOwn(patch, key));
    if (updates.length === 0) return this.getSession(sid) !== null;

    const assignments = updates.map(([, column]) => `${column} = ?`).join(', ');
    const values = updates.map(([key]) => patch[key]);
    const result = this.db.prepare(`UPDATE sessions SET ${assignments} WHERE sid = ?`).run(...values, sid);
    return result.changes === 1;
  }

  deleteSession(sid: string): boolean {
    return this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid).changes === 1;
  }

  recoverOnStartup(): number {
    const recover = this.db.transaction(() => {
      // Turn commands still queued behind another command were acked but never run; report them too,
      // or the Leader waits forever (a resend is deduplicated by msg_id).
      const rows = (this.db.prepare("SELECT * FROM inbox WHERE state IN ('running', 'received') ORDER BY received_at, msg_id")
        .all() as InboxRow[]).filter((row) => row.state === 'running' || isTurnCommand(row));
      for (const row of rows) {
        const evt = interruptedEvent(row);
        const resultEvtMsgId = randomUUID();
        this.insertEvent(resultEvtMsgId, evt, this.now());
        this.db.prepare(`
          UPDATE inbox SET state = 'done', result_evt_msg_id = ?, finished_at = ?
          WHERE msg_id = ? AND state IN ('running', 'received')
        `).run(resultEvtMsgId, this.now(), row.msg_id);
      }
      return rows.length;
    });
    return recover();
  }

  close(): void {
    this.db.close();
  }

  private insertEvent(msgId: string, evt: Event, createdAt: number): void {
    this.db.prepare('INSERT INTO outbox (msg_id, evt, created_at) VALUES (?, ?, ?)')
      .run(msgId, JSON.stringify(evt), createdAt);
  }
}

export async function openJournal(dataDir: string, now: () => number = Date.now): Promise<NodeJournal> {
  return NodeJournal.open(dataDir, now);
}

export function recoverOnStartup(journal: NodeJournal): number {
  return journal.recoverOnStartup();
}

function isTurnCommand(row: InboxRow): boolean {
  try {
    const type = (JSON.parse(row.cmd) as { type?: unknown }).type;
    return typeof type === 'string' && (type.startsWith('author.') || type.startsWith('review.') || type === 'directive.run');
  } catch {
    return false;
  }
}

function interruptedEvent(row: InboxRow): Event {
  let command: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(row.cmd);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('command is not an object');
    command = parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Cannot recover command ${row.msg_id}: invalid stored JSON`, { cause: error });
  }
  if (typeof command.sid !== 'string' || command.sid.length === 0) {
    throw new Error(`Cannot recover command ${row.msg_id}: missing sid`);
  }

  return {
    type: 'turn.failed',
    inReplyTo: row.msg_id,
    sid: command.sid,
    ...(typeof command.taskId === 'number' ? { taskId: command.taskId } : {}),
    ...(typeof command.directiveId === 'string' ? { directiveId: command.directiveId } : {}),
    code: 'INTERRUPTED',
    message: 'Node restarted while the command was running',
  };
}

function mapInbox(row: InboxRow): InboxRecord {
  return {
    msgId: row.msg_id,
    cmd: JSON.parse(row.cmd) as Command,
    state: row.state,
    resultEvtMsgId: row.result_evt_msg_id,
    receivedAt: row.received_at,
    finishedAt: row.finished_at,
  };
}

function mapSession(row: SessionRow): JournalSession {
  return {
    sid: row.sid,
    nativeId: row.native_id,
    worktree: row.worktree,
    profile: row.profile,
    contextTokens: row.context_tokens,
    state: row.state,
    createdAt: row.created_at,
  };
}
