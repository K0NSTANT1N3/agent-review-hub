import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { join } from 'node:path';
import {
  API_ROUTES,
  apiPath,
  parseLeaderConfig,
  parseNodeConfig,
  type ApiRouteName,
  type LeaderConfig,
  type NodeConfig,
  type OwnerSettings,
  type UiEvent,
} from '@quorum/protocol';
import type { ApiCallOptions, ApiResult, AppState, DesktopSettings, HostSetup, JoinSetup, Mode } from '../shared/ipc.js';
import { agentIdFor, decodeJoinCode, encodeJoinCode, httpBaseFromLeaderUrl } from './join-code.js';
import { UiStream } from './ui-stream.js';

const execFileAsync = promisify(execFile);

// Owns the in-process Leader (host mode) and Node daemon; no Electron imports so it is testable with plain Node.

export interface LeaderHandleLike {
  port: number;
  close(): Promise<void>;
}
export interface DaemonHandleLike {
  stop(): Promise<void>;
  status(): AppState['node']['status'];
  updateSettings(patch: Partial<OwnerSettings>): void;
}

export interface ServiceDeps {
  startLeader(config: LeaderConfig): Promise<LeaderHandleLike>;
  addAgent(dbPath: string, args: { id: string; owner: string }): Promise<{ token: string }>;
  startDaemon(config: NodeConfig, opts: { idleSeconds?: () => number | null }): Promise<DaemonHandleLike>;
  secrets: { encrypt(plain: string): string; decrypt(stored: string): string };
  idleSeconds?: () => number | null;
  claudeExecutable?: () => string | undefined;
}

interface StoredConfig {
  version: 1;
  mode: Mode;
  ownerName: string;
  agentId: string;
  repoRemoteUrl: string;
  leaderUrl: string;
  tokenStored: string;
  host?: { mainBranch: string; port: number; publicHost: string };
  settings: DesktopSettings;
}

export class Services {
  private config: StoredConfig | null = null;
  private leader: LeaderHandleLike | null = null;
  private leaderError: string | null = null;
  private daemon: DaemonHandleLike | null = null;
  private nodeError: string | null = null;
  private ui: UiStream | null = null;
  private connected = false;
  private readonly configPath: string;

  constructor(
    readonly dataDir: string,
    private readonly deps: ServiceDeps,
    private readonly emitState: (state: AppState) => void = () => {},
    private readonly emitUi: (event: UiEvent) => void = () => {},
  ) {
    mkdirSync(dataDir, { recursive: true });
    this.configPath = join(dataDir, 'quorum-desktop.json');
  }

  async boot(): Promise<AppState> {
    if (existsSync(this.configPath)) {
      try {
        this.config = JSON.parse(readFileSync(this.configPath, 'utf8')) as StoredConfig;
      } catch {
        this.config = null;
      }
    }
    if (this.config !== null) await this.startAll();
    return this.state();
  }

  state(): AppState {
    const c = this.config;
    return {
      configured: c !== null,
      mode: c?.mode ?? null,
      ownerName: c?.ownerName ?? null,
      agentId: c?.agentId ?? null,
      repoRemoteUrl: c?.repoRemoteUrl ?? null,
      isAdmin: c?.mode === 'host',
      leader:
        c?.mode === 'host'
          ? {
              running: this.leader !== null,
              port: this.leader?.port ?? c.host?.port ?? null,
              publicUrl: c.host !== undefined ? `ws://${c.host.publicHost}:${c.host.port}/ws/node` : null,
              error: this.leaderError,
            }
          : null,
      node: { running: this.daemon !== null, error: this.nodeError, status: safeStatus(this.daemon) },
      connected: this.connected,
      settings: c?.settings ?? null,
      dataDir: this.dataDir,
    };
  }

  async setupHost(setup: HostSetup): Promise<AppState> {
    const ownerName = setup.ownerName.trim();
    if (ownerName === '') throw new Error('Your name is required');
    if (setup.repoRemoteUrl.trim() === '') throw new Error('The repository URL is required');
    if (!Number.isInteger(setup.port) || setup.port < 1 || setup.port > 65535) throw new Error('Port must be 1–65535');
    await this.stopAll();
    const agentId = agentIdFor(ownerName);
    const host = { mainBranch: setup.mainBranch.trim() || 'main', port: setup.port, publicHost: setup.publicHost.trim() || '127.0.0.1' };
    const draft: StoredConfig = {
      version: 1,
      mode: 'host',
      ownerName,
      agentId,
      repoRemoteUrl: setup.repoRemoteUrl.trim(),
      leaderUrl: `ws://127.0.0.1:${host.port}/ws/node`,
      tokenStored: '',
      host,
      settings: setup.settings,
    };
    // Start the Leader first so a bad repo URL or busy port is reported before anything is saved.
    this.config = draft;
    await this.startLeader();
    if (this.leader === null) {
      const error = this.leaderError ?? 'Leader failed to start';
      this.config = null;
      this.leaderError = null;
      throw new Error(error);
    }
    const { token } = await this.deps.addAgent(this.leaderConfig().dbPath, { id: agentId, owner: ownerName });
    draft.tokenStored = this.deps.secrets.encrypt(token);
    this.save(draft);
    await this.startNode();
    this.startUi();
    return this.changed();
  }

  async setupJoin(setup: JoinSetup): Promise<AppState> {
    const code = decodeJoinCode(setup.joinCode);
    await this.stopAll();
    this.save({
      version: 1,
      mode: 'join',
      ownerName: code.ownerName,
      agentId: code.agentId,
      repoRemoteUrl: code.repoRemoteUrl,
      leaderUrl: code.leaderUrl,
      tokenStored: this.deps.secrets.encrypt(code.token),
      settings: setup.settings,
    });
    await this.startAll();
    return this.state();
  }

  /** Host only: registers a teammate's agent and returns a join code to send them. */
  async invite(args: { agentId: string; ownerName: string }): Promise<{ joinCode: string }> {
    const c = this.requireConfig();
    if (c.mode !== 'host' || c.host === undefined) throw new Error('Only the host can invite teammates');
    const ownerName = args.ownerName.trim();
    if (ownerName === '') throw new Error('Teammate name is required');
    const agentId = args.agentId.trim() || agentIdFor(ownerName);
    if (agentId === c.agentId) throw new Error('That agent id is yours; pick another');
    const { token } = await this.deps.addAgent(this.leaderConfig().dbPath, { id: agentId, owner: ownerName });
    return {
      joinCode: encodeJoinCode({
        leaderUrl: `ws://${c.host.publicHost}:${c.host.port}/ws/node`,
        agentId,
        ownerName,
        token,
        repoRemoteUrl: c.repoRemoteUrl,
      }),
    };
  }

  async updateSettings(settings: DesktopSettings): Promise<AppState> {
    const c = this.requireConfig();
    const adapterChanged = JSON.stringify(c.settings.adapter) !== JSON.stringify(settings.adapter);
    this.save({ ...c, settings });
    if (adapterChanged || this.daemon === null) {
      await this.stopNode();
      await this.startNode();
    } else {
      this.daemon.updateSettings(ownerSettings(settings));
    }
    return this.changed();
  }

  /** Cheap readiness check of the configured agent (no model call, no tokens). */
  async checkAgent(): Promise<{ ok: boolean; detail: string }> {
    const adapter = this.requireConfig().settings.adapter;
    if (adapter.type === 'mock') {
      return existsSync(adapter.scriptPath) ? { ok: true, detail: 'Mock script found.' } : { ok: false, detail: `Mock script not found: ${adapter.scriptPath}` };
    }
    if (adapter.type === 'opencode') {
      try {
        const res = await fetch(new URL('/doc', adapter.baseUrl), { signal: AbortSignal.timeout(5000) });
        return { ok: res.ok, detail: res.ok ? `opencode server reachable at ${adapter.baseUrl}.` : `opencode answered HTTP ${res.status}.` };
      } catch (error) {
        return { ok: false, detail: `Cannot reach opencode at ${adapter.baseUrl}: ${describe(error)}` };
      }
    }
    const bin = this.deps.claudeExecutable?.();
    if (bin === undefined) return { ok: false, detail: 'The bundled Claude Code CLI was not found. Reinstall Quorum or set QUORUM_CLAUDE_PATH.' };
    try {
      const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 20_000 });
      return { ok: true, detail: `Claude Code ${stdout.trim()} is ready. If agent turns fail, run \`claude\` once in a terminal to sign in.` };
    } catch (error) {
      return { ok: false, detail: `Claude Code could not start: ${describe(error)}` };
    }
  }

  async restart(): Promise<AppState> {
    await this.stopAll();
    await this.startAll();
    return this.state();
  }

  /** Forgets this machine's setup (the Leader database of a host is kept on disk). */
  async reset(): Promise<AppState> {
    await this.stopAll();
    rmSync(this.configPath, { force: true });
    this.config = null;
    return this.changed();
  }

  async api<R extends ApiRouteName>(route: R, options: ApiCallOptions = {}): Promise<ApiResult<R>> {
    const c = this.requireConfig();
    const def = API_ROUTES[route];
    const url = new URL(apiPath(route, options.id), httpBaseFromLeaderUrl(c.leaderUrl));
    for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { authorization: `Bearer ${this.token()}` };
    const init: RequestInit = { method: def.method, headers };
    if (def.method !== 'GET') {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(options.body ?? {});
    }
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      return { ok: false, status: 0, error: 'UNREACHABLE', message: `Cannot reach the Leader at ${url.origin}: ${(error as Error).message}` };
    }
    const text = await res.text();
    const json: unknown = text === '' ? null : safeJson(text);
    if (res.status !== def.status) {
      const body = (json ?? {}) as { error?: string; message?: string };
      return { ok: false, status: res.status, error: body.error ?? 'HTTP_ERROR', message: body.message ?? `HTTP ${res.status}` };
    }
    return { ok: true, data: json as ApiResult<R> extends { data: infer D } ? D : never };
  }

  async stopAll(): Promise<void> {
    this.ui?.stop();
    this.ui = null;
    this.connected = false;
    await this.stopNode();
    if (this.leader !== null) {
      await this.leader.close().catch(() => undefined);
      this.leader = null;
    }
    this.leaderError = null;
  }

  // ---------------------------------------------------------------------------

  private async startAll(): Promise<void> {
    if (this.config?.mode === 'host') await this.startLeader();
    await this.startNode();
    this.startUi();
    this.changed();
  }

  private leaderConfig(): LeaderConfig {
    const c = this.requireConfig();
    if (c.host === undefined) throw new Error('not a host');
    const dir = join(this.dataDir, 'leader');
    return parseLeaderConfig({
      listen: { host: '0.0.0.0', port: c.host.port },
      dbPath: join(dir, 'leader.db'),
      repo: { remoteUrl: c.repoRemoteUrl, mainBranch: c.host.mainBranch, clonePath: join(dir, 'repo') },
      admins: [c.ownerName],
    });
  }

  private async startLeader(): Promise<void> {
    this.leaderError = null;
    try {
      this.leader = await this.deps.startLeader(this.leaderConfig());
    } catch (error) {
      this.leader = null;
      this.leaderError = describe(error);
    }
  }

  private nodeConfig(): NodeConfig {
    const c = this.requireConfig();
    const s = c.settings;
    return parseNodeConfig({
      leaderUrl: c.leaderUrl,
      agentId: c.agentId,
      token: this.token(),
      ownerName: c.ownerName,
      dataDir: join(this.dataDir, 'node'),
      workspaceDir: join(this.dataDir, 'workspace'),
      repoRemoteUrl: c.repoRemoteUrl,
      gitIdentity: { name: `${c.ownerName} (quorum agent)`, email: `${c.agentId}@quorum.local` },
      adapter: s.adapter,
      maxSessions: s.maxSessions,
      lendMode: s.lendMode,
      idleThresholdSec: s.idleThresholdSec,
      lendTokensPerDay: s.lendTokensPerDay,
      paused: s.paused,
      tags: s.tags,
    });
  }

  private async startNode(): Promise<void> {
    this.nodeError = null;
    try {
      this.daemon = await this.deps.startDaemon(this.nodeConfig(), {
        ...(this.deps.idleSeconds !== undefined ? { idleSeconds: this.deps.idleSeconds } : {}),
      });
    } catch (error) {
      this.daemon = null;
      this.nodeError = describe(error);
    }
  }

  private async stopNode(): Promise<void> {
    if (this.daemon !== null) {
      await this.daemon.stop().catch(() => undefined);
      this.daemon = null;
    }
  }

  private startUi(): void {
    const c = this.config;
    if (c === null) return;
    this.ui?.stop();
    this.ui = new UiStream(httpBaseFromLeaderUrl(c.leaderUrl), this.token(), {
      onEvent: (e) => this.emitUi(e),
      onConnection: (up) => {
        this.connected = up;
        this.changed();
      },
    });
    this.ui.start();
  }

  private token(): string {
    return this.deps.secrets.decrypt(this.requireConfig().tokenStored);
  }

  private requireConfig(): StoredConfig {
    if (this.config === null) throw new Error('Quorum is not set up yet');
    return this.config;
  }

  private save(config: StoredConfig): void {
    this.config = config;
    writeFileSync(this.configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  }

  private changed(): AppState {
    const s = this.state();
    this.emitState(s);
    return s;
  }
}

export function ownerSettings(s: DesktopSettings): Partial<OwnerSettings> {
  return {
    maxSessions: s.maxSessions,
    lendMode: s.lendMode,
    lendTokensPerDay: s.lendTokensPerDay,
    paused: s.paused,
    tags: s.tags,
    idleThresholdSec: s.idleThresholdSec,
    contextWindow: s.adapter.contextWindow,
  };
}

function safeStatus(d: DaemonHandleLike | null): AppState['node']['status'] {
  try {
    return d?.status() ?? null;
  } catch {
    return null;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: 'BAD_RESPONSE', message: text.slice(0, 200) };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
