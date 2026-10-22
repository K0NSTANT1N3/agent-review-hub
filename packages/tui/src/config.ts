import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

export interface ConnectionConfig {
  url: string;
  token: string;
}

export type Env = Record<string, string | undefined>;

// Keep the path, JSON format and precedence compatible with packages/cli/src/config.ts.
export function configPath(env: Env): string {
  return env.QUORUM_CONFIG || join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'quorum', 'cli.json');
}

export function readConfig(path: string, platform: NodeJS.Platform = process.platform): { config: Partial<ConnectionConfig>; warning?: string } {
  try {
    const mode = statSync(path).mode;
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const data = parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    return {
      config: {
        ...(typeof data.url === 'string' ? { url: data.url } : {}),
        ...(typeof data.token === 'string' ? { token: data.token } : {}),
      },
      // Windows reports no POSIX permission bits (files show 0o666); access there is an ACL matter.
      ...(platform !== 'win32' && (mode & 0o044) !== 0 ? { warning: `Token config is group/world readable: ${path}. Run chmod 600 on it.` } : {}),
    };
  } catch {
    return { config: {} };
  }
}

export function resolveConfig(flags: Partial<ConnectionConfig>, env: Env) {
  const { config, warning } = readConfig(configPath(env));
  return {
    url: flags.url ?? env.QUORUM_URL ?? config.url,
    token: flags.token ?? env.QUORUM_TOKEN ?? config.token,
    warning,
  };
}

export function parseFlags(args: string[]) {
  return parseArgs({ args, options: { url: { type: 'string' }, token: { type: 'string' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' } } }).values;
}

/** Accepts the Leader's http(s) base or its ws(s)://host:port/ws/node join URL, like the quorum CLI. */
export function normalizeLeaderUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol === 'ws:') url.protocol = 'http:';
  else if (url.protocol === 'wss:') url.protocol = 'https:';
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Leader URL must use http(s):// or ws(s)://');
  if (url.username || url.password) throw new Error('Use --token for authentication, not credentials in the URL');
  return url.origin;
}
