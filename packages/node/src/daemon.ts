import { access, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import pino, { type Logger } from 'pino';
import {
  NodeStatusSchema,
  OwnerSettingsSchema,
  ownerSettingsFromNodeConfig,
  parseNodeConfig,
  type NodeConfig,
  type NodeStatus,
  type OwnerSettings,
} from '@quorum/protocol';
import { createAdapter } from './adapters/index.js';
import type { AgentAdapter } from './adapters/types.js';
import { assertGitSuccess, git } from './git/git.js';
import { ensureBaseClone, type WorktreeConfig } from './git/worktrees.js';
import { NodeJournal, openJournal } from './journal.js';
import { CommandRunner } from './runner/command-runner.js';
import { LeaderClient } from './ws/leader-client.js';

const DEFAULT_TURN_TIMEOUT_SEC = 1800;
const ASSUMED_IDLE_SECONDS = Number.MAX_SAFE_INTEGER;

export interface DaemonHandle {
  stop(): Promise<void>;
  status(): NodeStatus;
  updateSettings(patch: Partial<OwnerSettings>): void;
}

export interface StartDaemonOptions {
  /** Desktop passes Electron's `powerMonitor.getSystemIdleTime`; headless omits it. */
  idleSeconds?: () => number | null;
  /** Tests may inject; otherwise created from config.adapter. */
  adapter?: AgentAdapter;
  assumeIdle?: boolean;
  insecure?: boolean;
}

/** Starts the local Node service and connects it to the Leader. */
export async function startDaemon(input: NodeConfig, options: StartDaemonOptions = {}): Promise<DaemonHandle> {
  const config = normalizeConfig(input);
  const logger = pino({ level: process.env.QUORUM_LOG_LEVEL ?? 'info' }).child({ agentId: config.agentId });
  const journal = await openJournal(config.dataDir);
  let leaderClient: LeaderClient | undefined;

  try {
    const interrupted = journal.recoverOnStartup();
    logger.info({ interruptedCommands: interrupted }, 'node journal recovered');

    const worktreeConfig: WorktreeConfig = {
      workspaceDir: config.workspaceDir,
      repoRemoteUrl: config.repoRemoteUrl,
      mainBranch: 'main',
      gitIdentity: config.gitIdentity,
    };
    const repoPath = await ensureBaseClone(worktreeConfig);
    const fetched = await git(repoPath, ['fetch', 'origin', '--prune']);
    assertGitSuccess(fetched, 'fetch origin during node startup');
    await restoreSessions(journal, logger);

    const adapter = options.adapter ?? await createAdapter(config.adapter, {
      authorBashAllow: config.authorBashAllow,
    });
    let settings = ownerSettingsFromNodeConfig(config);
    let mainBranch = 'main';
    let turnTimeoutSec = DEFAULT_TURN_TIMEOUT_SEC;
    let rateLimitedUntil: number | null = null;
    let stopped = false;
    let stopPromise: Promise<void> | null = null;
    const clientRef: { current?: LeaderClient } = {};

    const getRateLimitedUntil = (): number | null => {
      if (rateLimitedUntil !== null && rateLimitedUntil <= Date.now()) rateLimitedUntil = null;
      return rateLimitedUntil;
    };
    const status = (): NodeStatus => {
      let humanIdleSec: number | null;
      try {
        humanIdleSec = options.idleSeconds !== undefined
          ? options.idleSeconds()
          : options.assumeIdle === true ? ASSUMED_IDLE_SECONDS : null;
      } catch (error) {
        logger.warn({ error: errorMessage(error) }, 'could not read human idle time');
        humanIdleSec = null;
      }
      const sessions = journal.listSessions().map((session) => ({
        sid: session.sid,
        alive: session.state !== 'closed' && session.state !== 'lost',
        busy: session.state === 'busy',
        contextTokens: session.contextTokens,
      }));
      return NodeStatusSchema.parse({
        settings: { ...settings, tags: [...settings.tags] },
        humanIdleSec,
        rateLimitedUntil: getRateLimitedUntil(),
        sessions,
      });
    };

    const runner = new CommandRunner({
      config,
      journal,
      adapter,
      enqueueEvent: (event) => clientRef.current?.enqueueEvent(event) ?? journal.enqueueEvent(event),
      mainBranch: () => mainBranch,
      turnTimeoutSec: () => turnTimeoutSec,
      getContextWindow: () => settings.contextWindow,
      onRateLimited: (resetAt) => {
        rateLimitedUntil = resetAt ?? Date.now() + 15 * 60 * 1000;
        logger.warn({ rateLimitedUntil }, 'adapter rate limit reached');
      },
      onError: (error) => logger.error({ error }, 'command runner error'),
    });

    leaderClient = new LeaderClient({
      config,
      journal,
      onCommand: (msgId, command) => {
        logger.info({
          msgId,
          sid: command.sid,
          taskId: 'taskId' in command ? command.taskId ?? null : null,
          conversationId: 'conversationId' in command ? command.conversationId : null,
        }, 'received command');
        runner.dispatch(msgId, command);
      },
      getSettings: () => settings,
      idleSeconds: options.idleSeconds,
      ...(options.assumeIdle === undefined ? {} : { assumeIdle: options.assumeIdle }),
      ...(options.insecure === undefined ? {} : { insecure: options.insecure }),
      getRateLimitedUntil,
      onWelcome: (welcome) => {
        mainBranch = welcome.mainBranch;
        turnTimeoutSec = welcome.turnTimeoutSec;
        logger.info({ mainBranch, turnTimeoutSec }, 'connected to Leader');
      },
      onReject: (reason) => logger.error({ reason }, 'Leader rejected this Node'),
      onError: (error) => logger.warn({ error }, 'Leader connection error'),
    });
    clientRef.current = leaderClient;
    leaderClient.start();

    return {
      stop: () => {
        if (stopPromise !== null) return stopPromise;
        stopped = true;
        stopPromise = (async () => {
          // Stop turns first, then disconnect so no new commands arrive while queued work drains.
          runner.stop();
          await leaderClient?.stop();
          await runner.drain();
          journal.close();
          logger.info({ stopped }, 'node daemon stopped');
        })();
        return stopPromise;
      },
      status,
      updateSettings: (patch) => {
        if (stopped) throw new Error('Cannot update settings after the Node daemon has stopped.');
        settings = OwnerSettingsSchema.parse({ ...settings, ...patch });
      },
    };
  } catch (error) {
    await leaderClient?.stop().catch(() => undefined);
    journal.close();
    throw error;
  }
}

async function restoreSessions(journal: NodeJournal, logger: Logger): Promise<void> {
  for (const session of journal.listSessions()) {
    if (session.state === 'closed') continue;
    if (await sessionWorktreeExists(session.worktree)) {
      journal.updateSession(session.sid, { state: 'idle' });
      continue;
    }
    if (session.state === 'lost') continue;
    journal.updateSession(session.sid, { state: 'lost' });
    const reason = `session worktree is missing or invalid: ${session.worktree}`;
    journal.enqueueEvent({ type: 'session.lost', sid: session.sid, reason });
    logger.warn({ sid: session.sid, worktree: session.worktree }, 'session worktree missing during startup');
  }
}

async function sessionWorktreeExists(worktree: string): Promise<boolean> {
  try {
    await access(worktree);
    const result = await git(worktree, ['rev-parse', '--show-toplevel']);
    // Compare real paths: git reports the symlink-resolved root (macOS /var -> /private/var).
    return result.code === 0 && (await realpath(result.stdout.trim())) === (await realpath(worktree));
  } catch {
    return false;
  }
}

function normalizeConfig(input: NodeConfig): NodeConfig {
  const parsed = parseNodeConfig(input);
  const adapter = parsed.adapter.type === 'mock'
    ? { ...parsed.adapter, scriptPath: absolutePath(parsed.adapter.scriptPath) }
    : parsed.adapter;
  return {
    ...parsed,
    dataDir: absolutePath(parsed.dataDir),
    workspaceDir: absolutePath(parsed.workspaceDir),
    repoRemoteUrl: expandHome(parsed.repoRemoteUrl),
    adapter,
  };
}

function absolutePath(path: string): string {
  const expanded = expandHome(path);
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith(`~${sep}`) || path.startsWith('~\\')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
