import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';

export const SCHEMA_VERSION = 5;

export function migrate(db: Database.Database): void {
  // WAL must be configured outside a transaction; foreign keys are per connection.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.transaction(() => {
    db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)');
    const rows = db.prepare('SELECT version FROM schema_version').all() as { version: number }[];
    if (rows.length > 1 || (rows[0] !== undefined && rows[0].version > SCHEMA_VERSION)) {
      throw new Error(`Unsupported database schema version: ${rows.map((row) => row.version).join(',')}`);
    }
    if (rows[0]?.version === 1) {
      // v2 adds api_tokens (the last table in schema.sql) and sessions.profile, which is recovered from the
      // session.open command that created each session.
      const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
      db.exec(schema.slice(schema.indexOf('CREATE TABLE api_tokens'), schema.indexOf('-- v4:')));
      db.exec('ALTER TABLE sessions ADD COLUMN profile TEXT');
      db.exec(`UPDATE sessions SET profile = (
        SELECT json_extract(m.payload, '$.cmd.profile') FROM messages m
        WHERE m.direction = 'to_node' AND m.type = 'session.open' AND m.session_id = sessions.id
        ORDER BY m.rowid DESC LIMIT 1)`);
      db.prepare('UPDATE schema_version SET version = ?').run(2);
    }
    if (rows[0] !== undefined && rows[0].version < 3) {
      // v3 adds tasks.require_human_approval (PR #93).
      db.exec('ALTER TABLE tasks ADD COLUMN require_human_approval INTEGER NOT NULL DEFAULT 0');
      db.prepare('UPDATE schema_version SET version = ?').run(3);
    }
    if (rows[0] !== undefined && rows[0].version < 4) {
      const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
      db.exec(schema.slice(schema.indexOf('-- v4:'), schema.indexOf('-- v5:')));
      db.prepare('UPDATE schema_version SET version = ?').run(4);
    }
    if (rows[0] !== undefined && rows[0].version < 5) {
      const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
      db.exec(schema.slice(schema.indexOf('-- v5:')));
      db.prepare('UPDATE schema_version SET version = ?').run(5);
    }
    if (rows.length === 0) {
      const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
      // Connection pragmas above already applied; changing journal mode in a tx is invalid.
      db.exec(schema.replace(/^PRAGMA .*;\s*$/gm, ''));
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    }
  }).immediate();
}
