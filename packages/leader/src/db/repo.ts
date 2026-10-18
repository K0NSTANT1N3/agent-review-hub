import Database from 'better-sqlite3';
import { migrate, SCHEMA_VERSION } from './migrations.js';
import type { Inserts, KeyColumn, MessageRow, Patch, RowKey, Tables } from './types.js';

type Value = string | number | null;
type SyncResult<T> = T & ({ readonly then?: never } | null | undefined | void);

export class NotFoundError extends Error {
  constructor(table: string, id: string | number) {
    super(`${table} row not found: ${id}`);
    this.name = 'NotFoundError';
  }
}

export class TableRepo<N extends keyof Tables> {
  private readonly columns: Set<string>;
  private readonly key: KeyColumn<N>;

  constructor(private readonly owner: LeaderDb, private readonly sql: Database.Database, private readonly name: N) {
    this.key = (name === 'merge_queue' ? 'task_id' : 'id') as KeyColumn<N>;
    this.columns = new Set((sql.pragma(`table_info(${name})`) as { name: string }[]).map((c) => c.name));
  }

  get(id: RowKey<N>): Tables[N] | undefined {
    return this.sql.prepare(`SELECT * FROM ${this.name} WHERE ${this.key} = ?`).get(id) as Tables[N] | undefined;
  }

  require(id: RowKey<N>): Tables[N] {
    const row = this.get(id);
    if (row === undefined) throw new NotFoundError(this.name, id);
    return row;
  }

  all(): Tables[N][] {
    return this.find({});
  }

  find(where: Partial<Tables[N]>): Tables[N][] {
    const entries = this.entries(where);
    const clause = entries.length === 0 ? '' : ` WHERE ${entries.map(([key]) => `${key} IS ?`).join(' AND ')}`;
    return this.sql.prepare(`SELECT * FROM ${this.name}${clause} ORDER BY ${this.key}`).all(...entries.map(([, v]) => v)) as Tables[N][];
  }

  insert(values: Inserts[N]): Tables[N] {
    return this.owner.withTx(() => {
      const entries = this.entries(values);
      if (entries.length === 0) throw new TypeError('Insert requires values');
      const row = this.sql.prepare(`INSERT INTO ${this.name} (${entries.map(([key]) => key).join(', ')}) VALUES (${entries.map(() => '?').join(', ')}) RETURNING *`)
        .get(...entries.map(([, value]) => value)) as Tables[N];
      return row;
    });
  }

  update(id: RowKey<N>, patch: Patch<N>): Tables[N] {
    return this.owner.withTx(() => {
      const entries = this.entries(patch);
      if (entries.some(([key]) => key === this.key)) throw new TypeError('Primary keys are immutable');
      if (this.name === 'conversations' && entries.some(([key]) => !['state', 'next_seq', 'ended_at'].includes(key))) {
        throw new TypeError('Conversation participants are immutable');
      }
      if (entries.length === 0) return this.require(id);
      const row = this.sql.prepare(`UPDATE ${this.name} SET ${entries.map(([key]) => `${key} = ?`).join(', ')} WHERE ${this.key} = ? RETURNING *`)
        .get(...entries.map(([, value]) => value), id) as Tables[N] | undefined;
      if (row === undefined) throw new NotFoundError(this.name, id);
      return row;
    });
  }

  delete(id: RowKey<N>): boolean {
    return this.owner.withTx(() => this.sql.prepare(`DELETE FROM ${this.name} WHERE ${this.key} = ?`).run(id).changes !== 0);
  }

  private entries(values: object): [string, Value][] {
    return Object.entries(values).map(([key, value]: [string, unknown]) => {
      if (!this.columns.has(key)) throw new TypeError(`Unknown ${this.name} column: ${key}`);
      if (value !== null && typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) {
        throw new TypeError(`Invalid ${this.name}.${key} value`);
      }
      // These columns are stored as JSON text, never as unvalidated SQL fragments.
      if (['tags', 'files', 'task_history', 'payload', 'data'].includes(key) && typeof value === 'string') {
        const parsed: unknown = JSON.parse(value);
        if (['tags', 'files'].includes(key) && (!Array.isArray(parsed) || !parsed.every((item: unknown) => typeof item === 'string'))) {
          throw new TypeError(`${key} must be a JSON string array`);
        }
        if (key === 'task_history' && (!Array.isArray(parsed) || !parsed.every((item: unknown) => typeof item === 'number' && Number.isSafeInteger(item)))) {
          throw new TypeError('task_history must be a JSON integer array');
        }
        if (['payload', 'data'].includes(key) && (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))) {
          throw new TypeError(`${key} must be a JSON object`);
        }
      }
      return [key, value];
    });
  }
}

export class LeaderDb {
  private readonly commitHooks: (() => void)[][] = [];
  readonly agents: TableRepo<'agents'>;
  readonly sessions: TableRepo<'sessions'>;
  readonly tasks: TableRepo<'tasks'>;
  readonly conversations: TableRepo<'conversations'>;
  readonly issues: TableRepo<'issues'>;
  readonly messages: TableRepo<'messages'>;
  readonly taskEvents: TableRepo<'task_events'>;
  readonly usageLedger: TableRepo<'usage_ledger'>;
  readonly directives: TableRepo<'directives'>;
  readonly mergeQueue: TableRepo<'merge_queue'>;

  constructor(private readonly sql: Database.Database) {
    migrate(sql);
    this.agents = new TableRepo(this, sql, 'agents');
    this.sessions = new TableRepo(this, sql, 'sessions');
    this.tasks = new TableRepo(this, sql, 'tasks');
    this.conversations = new TableRepo(this, sql, 'conversations');
    this.issues = new TableRepo(this, sql, 'issues');
    this.messages = new TableRepo(this, sql, 'messages');
    this.taskEvents = new TableRepo(this, sql, 'task_events');
    this.usageLedger = new TableRepo(this, sql, 'usage_ledger');
    this.directives = new TableRepo(this, sql, 'directives');
    this.mergeQueue = new TableRepo(this, sql, 'merge_queue');
  }

  withTx<T>(fn: () => SyncResult<T>): T {
    if (fn.constructor.name === 'AsyncFunction') {
      throw new TypeError('Database transactions must be synchronous');
    }
    const hooks: (() => void)[] = [];
    this.commitHooks.push(hooks);
    let result: T;
    try {
      result = this.sql.transaction(() => {
        const value = fn();
        if (value !== null && (typeof value === 'object' || typeof value === 'function') && 'then' in value) {
          throw new TypeError('Database transactions must be synchronous');
        }
        return value;
      }).immediate();
    } catch (error) {
      this.commitHooks.pop();
      throw error;
    }
    this.commitHooks.pop();
    const parent = this.commitHooks.at(-1);
    if (parent !== undefined) parent.push(...hooks);
    else for (const hook of hooks) hook();
    return result;
  }

  afterCommit(fn: () => void): void {
    const hooks = this.commitHooks.at(-1);
    if (hooks === undefined) fn();
    else hooks.push(fn);
  }

  unackedMessages(agentId?: string): MessageRow[] {
    const clause = agentId === undefined ? '' : ' AND agent_id = ?';
    // rowid preserves command issue order when timestamps have millisecond ties.
    return this.sql.prepare(`SELECT * FROM messages WHERE direction = 'to_node' AND acked_at IS NULL${clause} ORDER BY created_at, rowid`)
      .all(...(agentId === undefined ? [] : [agentId])) as MessageRow[];
  }

  get schemaVersion(): number {
    const row = this.sql.prepare('SELECT version FROM schema_version').get() as { version: number };
    return row.version;
  }

  get foreignKeysEnabled(): boolean {
    return this.sql.pragma('foreign_keys', { simple: true }) === 1;
  }

  get journalMode(): string {
    return String(this.sql.pragma('journal_mode', { simple: true }));
  }

  get integrity(): string {
    return String(this.sql.pragma('integrity_check', { simple: true }));
  }

  close(): void {
    this.sql.close();
  }
}

export function openDatabase(path: string): LeaderDb {
  const sql = new Database(path);
  try {
    return new LeaderDb(sql);
  } catch (error) {
    sql.close();
    throw error;
  }
}

export function withTx<T>(db: LeaderDb, fn: () => SyncResult<T>): T {
  return db.withTx(fn);
}

export { SCHEMA_VERSION };
export type * from './types.js';
