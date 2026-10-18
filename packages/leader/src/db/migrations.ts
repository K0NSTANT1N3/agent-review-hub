import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';

export const SCHEMA_VERSION = 1;

export function migrate(db: Database.Database): void {
  // WAL must be configured outside a transaction; foreign keys are per connection.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.transaction(() => {
    db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)');
    const rows = db.prepare('SELECT version FROM schema_version').all() as { version: number }[];
    if (rows.length > 1 || (rows[0] !== undefined && rows[0].version !== SCHEMA_VERSION)) {
      throw new Error(`Unsupported database schema version: ${rows.map((row) => row.version).join(',')}`);
    }
    if (rows.length === 0) {
      const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
      // Connection pragmas above already applied; changing journal mode in a tx is invalid.
      db.exec(schema.replace(/^PRAGMA .*;\s*$/gm, ''));
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    }
  }).immediate();
}
