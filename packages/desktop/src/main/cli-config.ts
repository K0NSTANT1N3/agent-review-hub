import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Writes the `quorum` CLI login that `quorum tui` also reads.
// Keep the path and JSON format compatible with packages/cli/src/config.ts.

export type Env = Record<string, string | undefined>;

/** `$QUORUM_CONFIG`, else `$XDG_CONFIG_HOME/quorum/cli.json`, else `~/.config/quorum/cli.json`. */
export function cliConfigPath(env: Env, home: string = homedir()): string {
  if (env.QUORUM_CONFIG) return env.QUORUM_CONFIG;
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'quorum', 'cli.json');
}

/**
 * Replaces the config with mode 0600. The secret goes into a new private file that is then renamed over the old one,
 * so it is never readable through an existing file's wider permissions.
 */
export function writeCliConfig(path: string, config: { url: string; token: string }): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}
