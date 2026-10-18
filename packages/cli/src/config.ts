import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface CliConfig {
  url: string;
  token: string;
}

export type Env = Record<string, string | undefined>;

/** `$QUORUM_CONFIG`, else `$XDG_CONFIG_HOME/quorum/cli.json`, else `~/.config/quorum/cli.json`. */
export function configPath(env: Env): string {
  if (env.QUORUM_CONFIG) return env.QUORUM_CONFIG;
  const base = env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'quorum', 'cli.json');
}

export function readConfigFile(path: string): Partial<CliConfig> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CliConfig>;
    return { ...(typeof parsed.url === 'string' ? { url: parsed.url } : {}), ...(typeof parsed.token === 'string' ? { token: parsed.token } : {}) };
  } catch {
    return {};
  }
}

/** Writes the config readable only by the current user (it holds a secret token). */
export function writeConfigFile(path: string, config: CliConfig): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Flags win over `QUORUM_URL` / `QUORUM_TOKEN`, which win over the config file. */
export function resolveConfig(flags: { url?: string; token?: string }, env: Env): Partial<CliConfig> {
  const file = readConfigFile(configPath(env));
  const url = flags.url ?? env.QUORUM_URL ?? file.url;
  const token = flags.token ?? env.QUORUM_TOKEN ?? file.token;
  return { ...(url ? { url } : {}), ...(token ? { token } : {}) };
}
