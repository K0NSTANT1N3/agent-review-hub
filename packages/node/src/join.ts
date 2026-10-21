import { closeSync, fchmodSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { LendModeSchema, parseNodeConfig, type LendMode, type NodeConfig, type NodeConfigInput } from '@quorum/protocol';
import { decodeJoinCode, isPrivateNetworkHost, type JoinCode } from '@quorum/protocol/join-code';

export const JOIN_USAGE = `quorum-node join <join code> [options]

Turns a join code from the Quorum host (desktop app "Invite" or "quorum-leader invite") into a
Node config file, so this machine can run an agent without the desktop app.

Options:
  --config <path>          where to write the config (default: ./quorum.node.json)
  --data-dir <dir>         Node state and worktrees go under this directory (default: ~/.quorum)
  --adapter <type>         claude-code (default), codex, pi, omp, opencode or mock
  --model <name>           claude-code/codex/pi/omp: model to use; opencode: model id (required)
  --opencode-url <url>     opencode: server URL (required for opencode)
  --provider <id>          opencode: provider id (required for opencode)
  --mock-script <path>     mock: script file (required for mock; for tests and demos)
  --lend-mode <mode>       always (default), when_idle or never
  --max-sessions <n>       concurrent agent sessions (default: 2)
  --tags <a,b>             expertise tags the Leader uses to pick reviewers
  --git-name <name>        commit author name (default: "<owner> (quorum agent)")
  --git-email <email>      commit author email (default: <agent id>@quorum.local)
  --force                  overwrite an existing config file`;

export interface JoinOptions {
  configPath: string;
  dataDir: string;
  adapter: 'claude-code' | 'codex' | 'pi' | 'omp' | 'opencode' | 'mock';
  model?: string;
  opencodeUrl?: string;
  provider?: string;
  mockScript?: string;
  lendMode: LendMode;
  maxSessions?: number;
  tags: string[];
  gitName?: string;
  gitEmail?: string;
  force: boolean;
}

export interface JoinResult {
  configPath: string;
  config: NodeConfig;
  startCommand: string;
}

export function parseJoinArgs(args: string[], cwd = process.cwd(), home = homedir()): { code: JoinCode; options: JoinOptions } {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      'data-dir': { type: 'string' },
      adapter: { type: 'string' },
      model: { type: 'string' },
      'opencode-url': { type: 'string' },
      provider: { type: 'string' },
      'mock-script': { type: 'string' },
      'lend-mode': { type: 'string' },
      'max-sessions': { type: 'string' },
      tags: { type: 'string' },
      'git-name': { type: 'string' },
      'git-email': { type: 'string' },
      force: { type: 'boolean' },
    },
  });
  if (positionals.length !== 1) throw new Error('Pass exactly one join code: quorum-node join <join code>');
  const code = decodeJoinCode(positionals[0]!);

  const adapter = values.adapter ?? 'claude-code';
  if (adapter !== 'claude-code' && adapter !== 'codex' && adapter !== 'pi' && adapter !== 'omp' && adapter !== 'opencode' && adapter !== 'mock') {
    throw new Error(`--adapter must be claude-code, codex, pi, omp, opencode or mock (got "${adapter}")`);
  }
  const lendMode = LendModeSchema.safeParse(values['lend-mode'] ?? 'always');
  if (!lendMode.success) throw new Error('--lend-mode must be always, when_idle or never');
  let maxSessions: number | undefined;
  if (values['max-sessions'] !== undefined) {
    maxSessions = Number(values['max-sessions']);
    if (!Number.isInteger(maxSessions) || maxSessions < 1) throw new Error('--max-sessions must be a positive whole number');
  }
  const absolute = (path: string): string => {
    const expanded = path === '~' ? home : path.startsWith('~/') ? join(home, path.slice(2)) : path;
    return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  };

  return {
    code,
    options: {
      configPath: absolute(values.config ?? 'quorum.node.json'),
      dataDir: absolute(values['data-dir'] ?? '~/.quorum'),
      adapter,
      ...(values.model !== undefined ? { model: values.model } : {}),
      ...(values['opencode-url'] !== undefined ? { opencodeUrl: values['opencode-url'] } : {}),
      ...(values.provider !== undefined ? { provider: values.provider } : {}),
      ...(values['mock-script'] !== undefined ? { mockScript: absolute(values['mock-script']) } : {}),
      lendMode: lendMode.data,
      ...(maxSessions !== undefined ? { maxSessions } : {}),
      tags: (values.tags ?? '').split(',').map((tag) => tag.trim()).filter((tag) => tag !== ''),
      ...(values['git-name'] !== undefined ? { gitName: values['git-name'] } : {}),
      ...(values['git-email'] !== undefined ? { gitEmail: values['git-email'] } : {}),
      force: values.force ?? false,
    },
  };
}

/** Same layout and git identity as the desktop app builds for a member who joins. */
export function nodeConfigFromJoinCode(code: JoinCode, options: JoinOptions): NodeConfig {
  const input: NodeConfigInput = {
    leaderUrl: code.leaderUrl,
    agentId: code.agentId,
    token: code.token,
    ownerName: code.ownerName,
    dataDir: join(options.dataDir, 'node'),
    workspaceDir: join(options.dataDir, 'workspace'),
    repoRemoteUrl: code.repoRemoteUrl,
    gitIdentity: {
      name: options.gitName ?? `${code.ownerName} (quorum agent)`,
      email: options.gitEmail ?? `${code.agentId}@quorum.local`,
    },
    adapter: adapterConfig(options),
    lendMode: options.lendMode,
    tags: options.tags,
    ...(options.maxSessions !== undefined ? { maxSessions: options.maxSessions } : {}),
  };
  return parseNodeConfig(input);
}

function adapterConfig(options: JoinOptions): NodeConfigInput['adapter'] {
  switch (options.adapter) {
    case 'claude-code':
    case 'codex':
    case 'pi':
    case 'omp':
      return { type: options.adapter, ...(options.model !== undefined ? { model: options.model } : {}) };
    case 'opencode':
      if (options.opencodeUrl === undefined || options.provider === undefined || options.model === undefined) {
        throw new Error('--adapter opencode needs --opencode-url, --provider and --model');
      }
      return { type: 'opencode', baseUrl: options.opencodeUrl, providerID: options.provider, modelID: options.model };
    case 'mock':
      if (options.mockScript === undefined) throw new Error('--adapter mock needs --mock-script <path>');
      return { type: 'mock', scriptPath: options.mockScript };
  }
}

/** The command that starts this Node; idle detection needs a human. */
export function startCommandFor(configPath: string, config: NodeConfig): string {
  const flags = [`--config ${shellQuote(configPath)}`];
  if (config.lendMode === 'when_idle') flags.push('--assume-idle');
  if (needsInsecure(config.leaderUrl)) flags.push('--insecure');
  return `quorum-node start ${flags.join(' ')}`;
}

export function needsInsecure(leaderUrl: string): boolean {
  const url = new URL(leaderUrl);
  return url.protocol === 'ws:' && !isPrivateNetworkHost(url.hostname);
}

/** Writes the config readable only by the current user: it holds the agent's secret token. */
export function writeNodeConfig(path: string, config: NodeConfig, force: boolean): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    // Exclusive creation also rejects dangling symlinks and a concurrent join's config.
    fd = openSync(path, force ? 'w' : 'wx', 0o600);
  } catch (error) {
    if (!force && error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new Error(`${path} already exists; pass --force to overwrite it`);
    }
    throw error;
  }
  try {
    // Existing files keep their permissions on open: restrict access before writing a new token.
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`);
  } finally {
    closeSync(fd);
  }
}

export function runJoin(args: string[], out: (line: string) => void, cwd = process.cwd(), home = homedir()): JoinResult {
  const { code, options } = parseJoinArgs(args, cwd, home);
  const config = nodeConfigFromJoinCode(code, options);
  writeNodeConfig(options.configPath, config, options.force);
  const startCommand = startCommandFor(options.configPath, config);
  out(`Wrote ${options.configPath} for ${code.ownerName} (agent ${code.agentId}, Leader ${code.leaderUrl}).`);
  out('The file holds the agent token and is readable only by you.');
  if (needsInsecure(code.leaderUrl)) {
    out('Warning: this public connection uses unencrypted ws://; prefer a VPN or TLS tunnel.');
  }
  out('Start the Node with:');
  out(`  ${startCommand}`);
  return { configPath: options.configPath, config, startCommand };
}

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
