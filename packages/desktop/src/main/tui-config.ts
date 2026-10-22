import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Writes the TUI-only login that `quorum tui` and `quorum-tui` read before the shared `quorum` CLI login.
// Owner tokens go here, never into cli.json, which users hand to coding agents.
// Keep the path and JSON format compatible with tuiConfigPath in packages/tui/src/config.ts.

export type Env = Record<string, string | undefined>;

/** `$QUORUM_TUI_CONFIG`, else `$XDG_CONFIG_HOME/quorum/tui.json`, else `~/.config/quorum/tui.json`. */
export function tuiConfigPath(env: Env, home: string = homedir()): string {
  if (env.QUORUM_TUI_CONFIG) return env.QUORUM_TUI_CONFIG;
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'quorum', 'tui.json');
}

/**
 * Replaces the config with mode 0600. The secret goes into a new private file that is then renamed over the old one,
 * so it is never readable through an existing file's wider permissions.
 */
export function writeTuiConfig(path: string, config: { url: string; token: string }): void {
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
