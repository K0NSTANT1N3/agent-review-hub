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
import { agentIdFor, decodeJoinCode, encodeJoinCode, httpBaseFromLeaderUrl, isEncryptedLeaderUrl, isValidPublicHost, publicLeaderUrl } from './join-code.js';
import { leaderNetworkKind } from './network.js';
import { UiStream } from './ui-stream.js';

const execFileAsync = promisify(execFile);
const INSECURE_REMOTE_LEADER = 'Refusing to send credentials to a remote Leader over unencrypted ws://. Configure a TLS proxy or tunnel and ask for a new secure join code.';

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host.startsWith('127.');
}

function requiresTls(leaderUrl: string): boolean {
  const url = new URL(leaderUrl);
  return url.protocol === 'ws:' && !isLoopbackHost(url.hostname);
}

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
  startDaemon(config: NodeConfig, opts: { idleSeconds?: () => number | null; insecure?: boolean; onReject?: (reason: string) => void }): Promise<DaemonHandleLike>;
  /** `isEncrypted` tells whether a stored value is protected by the OS keychain or kept as plain text. */
  secrets: { encrypt(plain: string): string; decrypt(stored: string): string; isEncrypted(stored: string): boolean };
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
  host?: { mainBranch: string; port: number; publicHost: string; restrictToIp?: string | null };
  settings: DesktopSettings;
}

export class Services {
  private config: StoredConfig | null = null;
  private leader: LeaderHandleLike | null = null;
  private leaderError: string | null = null;
  private daemon: DaemonHandleLike | null = null;
  private nodeError: string | null = null;
  /** Bumped on every Node start so a reject from an older daemon is ignored. */
  private nodeGeneration = 0;
  private authError: string | null = null;
  private ui: UiStream | null = null;
  private connected = false;
  private readonly configPath: string;
  // Lifecycle calls (boot, setup, settings, restart, reset, stop) run one at a time.
  private lifecycle: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private restarting: Promise<AppState> | null = null;

  constructor(
    readonly dataDir: string,
    private readonly deps: ServiceDeps,
    private readonly emitState: (state: AppState) => void = () => {},
    private readonly emitUi: (event: UiEvent) => void = () => {},
  ) {
    mkdirSync(dataDir, { recursive: true });
    this.configPath = join(dataDir, 'quorum-desktop.json');
  }

  boot(): Promise<AppState> {
    return this.serializedState(() => this.bootNow());
  }

  private async bootNow(): Promise<AppState> {
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
              publicUrl: c.host !== undefined ? publicLeaderUrl(c.host.publicHost, c.host.port) : null,
              restrictedTo: c.host?.restrictToIp ?? null,
              error: this.leaderError,
            }
          : null,
      node: { running: this.daemon !== null, error: this.nodeError, status: safeStatus(this.daemon) },
      connected: this.connected,
      apiUrl: c === null ? null : httpBaseFromLeaderUrl(c.leaderUrl),
      encrypted: c === null ? false : isEncryptedLeaderUrl(this.teamLeaderUrl(c)),
      leaderNetwork: c === null ? null : leaderNetworkKind(this.teamLeaderUrl(c)),
      authError: this.authError,
      secretsEncrypted: c === null || c.tokenStored === '' ? null : this.deps.secrets.isEncrypted(c.tokenStored),
      busy: this.pending > 0,
      settings: c?.settings ?? null,
      dataDir: this.dataDir,
    };
  }

  setupHost(setup: HostSetup): Promise<AppState> {
    return this.serializedState(() => this.setupHostNow(setup));
  }

  private async setupHostNow(setup: HostSetup): Promise<AppState> {
    const ownerName = setup.ownerName.trim();
    if (ownerName === '') throw new Error('Your name is required');
    if (setup.repoRemoteUrl.trim() === '') throw new Error('The repository URL is required');
    if (!Number.isInteger(setup.port) || setup.port < 1 || setup.port > 65535) throw new Error('Port must be 1–65535');
    await this.stopAllNow();
    const agentId = agentIdFor(ownerName);
    const restrictToIp = setup.restrictToIp?.trim() || null;
    if (restrictToIp !== null && !/^\d+\.\d+\.\d+\.\d+$/.test(restrictToIp)) throw new Error('Choose an address from the list to restrict connections to it');
    const host = { mainBranch: setup.mainBranch.trim() || 'main', port: setup.port, publicHost: setup.publicHost.trim() || restrictToIp || '127.0.0.1', restrictToIp };
    if (!isValidPublicHost(host.publicHost)) {
      throw new Error('The address must be a host name or IP without a port (wrap IPv6 addresses in [ ]), or a full https:// tunnel URL');
    }
    const draft: StoredConfig = {
      version: 1,
      mode: 'host',
      ownerName,
      agentId,
      repoRemoteUrl: setup.repoRemoteUrl.trim(),
      // The host's own agent connects locally — through the restricted address when one is set.
      leaderUrl: `ws://${restrictToIp ?? '127.0.0.1'}:${host.port}/ws/node`,
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

  setupJoin(setup: JoinSetup): Promise<AppState> {
    return this.serializedState(() => this.setupJoinNow(setup));
  }

  private async setupJoinNow(setup: JoinSetup): Promise<AppState> {
    const code = decodeJoinCode(setup.joinCode);
    if (requiresTls(code.leaderUrl)) throw new Error(INSECURE_REMOTE_LEADER);
    await this.stopAllNow();
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
    const leaderUrl = publicLeaderUrl(c.host.publicHost, c.host.port);
    if (requiresTls(leaderUrl)) throw new Error(`${INSECURE_REMOTE_LEADER} Set the host address to an https:// TLS proxy or tunnel URL.`);
    const { token } = await this.deps.addAgent(this.leaderConfig().dbPath, { id: agentId, owner: ownerName });
    return {
      joinCode: encodeJoinCode({
        leaderUrl,
        agentId,
        ownerName,
        token,
        repoRemoteUrl: c.repoRemoteUrl,
      }),
    };
  }

  updateSettings(settings: DesktopSettings): Promise<AppState> {
    return this.serializedState(() => this.updateSettingsNow(settings));
  }

  private async updateSettingsNow(settings: DesktopSettings): Promise<AppState> {
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

  /** A restart requested while one is in flight joins it instead of queueing another stop and start. */
  restart(): Promise<AppState> {
    this.restarting ??= this.serializedState(async () => {
      await this.stopAllNow();
      await this.startAll();
    }).finally(() => {
      this.restarting = null;
    });
    return this.restarting;
  }

  /**
   * Forgets this machine's setup and deletes the Node's clone and journal, so a later setup can use another repository.
   * A host's Leader data (all tasks and history) is deleted only when asked.
   */
  reset(options: { deleteLeaderData?: boolean } = {}): Promise<AppState> {
    return this.serializedState(async () => {
      await this.stopAllNow();
      rmSync(this.configPath, { force: true });
      const dirs = ['workspace', 'node', ...(options.deleteLeaderData === true ? ['leader'] : [])];
      for (const dir of dirs) rmSync(join(this.dataDir, dir), { recursive: true, force: true });
      this.config = null;
      this.nodeError = null;
      this.authError = null;
    });
  }

  async api<R extends ApiRouteName>(route: R, options: ApiCallOptions = {}): Promise<ApiResult<R>> {
    const c = this.requireConfig();
    if (requiresTls(c.leaderUrl)) {
      return { ok: false, status: 0, error: 'INSECURE_LEADER', message: INSECURE_REMOTE_LEADER };
    }
    const def = API_ROUTES[route];
    const url = new URL(apiPath(route, options.id), httpBaseFromLeaderUrl(c.leaderUrl));
    for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, v);
    let token: string;
    try {
      token = this.token();
    } catch (error) {
      return { ok: false, status: 0, error: 'TOKEN_UNREADABLE', message: tokenUnreadable(error) };
    }
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
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

  stopAll(): Promise<void> {
    return this.serialized(() => this.stopAllNow());
  }

  // ---------------------------------------------------------------------------

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    this.pending += 1;
    if (this.pending === 1) this.changed();
    const run = this.lifecycle.then(fn).finally(() => {
      this.pending -= 1;
      if (this.pending === 0) this.changed();
    });
    this.lifecycle = run.catch(() => undefined);
    return run;
  }

  /** The state is read after the call leaves the queue, so it does not report itself as busy. */
  private serializedState(fn: () => Promise<unknown>): Promise<AppState> {
    return this.serialized(fn).then(() => this.state());
  }

  private async stopAllNow(): Promise<void> {
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

  private async startAll(): Promise<void> {
    if (this.config?.mode === 'host') await this.startLeader();
    if (this.config !== null && requiresTls(this.config.leaderUrl)) {
      this.nodeError = INSECURE_REMOTE_LEADER;
      this.authError = INSECURE_REMOTE_LEADER;
      this.connected = false;
      this.changed();
      return;
    }
    await this.startNode();
    this.startUi();
    this.changed();
  }

  private leaderConfig(): LeaderConfig {
    const c = this.requireConfig();
    if (c.host === undefined) throw new Error('not a host');
    const dir = join(this.dataDir, 'leader');
    return parseLeaderConfig({
      listen: { host: c.host.restrictToIp ?? '0.0.0.0', port: c.host.port },
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
      const ip = this.config?.host?.restrictToIp;
      this.leaderError =
        ip && /EADDRNOTAVAIL|address not available/i.test(describe(error))
          ? `The address ${ip} is not on this computer right now. Connect your VPN, then click Restart.`
          : describe(error);
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
    const generation = ++this.nodeGeneration;
    try {
      this.daemon = await this.deps.startDaemon(this.nodeConfig(), {
        ...(this.deps.idleSeconds !== undefined ? { idleSeconds: this.deps.idleSeconds } : {}),
        onReject: (reason) => this.nodeRejected(generation, reason),
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

  /** The Leader refused the daemon's token: it has stopped reconnecting, so stop it and say why. */
  private nodeRejected(generation: number, reason: string): void {
    if (generation !== this.nodeGeneration) return;
    this.nodeError = `The Leader rejected this agent: ${reason}`;
    this.authError = this.authMessage(reason);
    this.changed();
    void this.serialized(async () => {
      if (generation === this.nodeGeneration) await this.stopNode();
    });
  }

  private authMessage(reason: string): string {
    const hint =
      this.config?.mode === 'host'
        ? 'Use "Disconnect this computer" in Settings and host again.'
        : 'Ask the host for a new join code, then use "Disconnect this computer" in Settings and join again.';
    return `The Leader no longer accepts this computer's agent token (${reason}). ${hint}`;
  }

  private startUi(): void {
    const c = this.config;
    if (c === null) return;
    if (requiresTls(c.leaderUrl)) {
      this.authError = INSECURE_REMOTE_LEADER;
      this.connected = false;
      return;
    }
    this.ui?.stop();
    this.ui = null;
    this.authError = null;
    let token: string;
    try {
      token = this.token();
    } catch (error) {
      this.authError = tokenUnreadable(error);
      return;
    }
    this.ui = new UiStream(httpBaseFromLeaderUrl(c.leaderUrl), token, {
      onEvent: (e) => this.emitUi(e),
      onConnection: (up) => {
        this.connected = up;
        this.changed();
      },
      onAuthError: (reason) => {
        this.authError = this.authMessage(reason);
        this.changed();
      },
    });
    this.ui.start();
  }

  private token(): string {
    return this.deps.secrets.decrypt(this.requireConfig().tokenStored);
  }

  /** The URL teammates use (for a host: the published address, not the local one). */
  private teamLeaderUrl(c: StoredConfig): string {
    return c.mode === 'host' && c.host !== undefined ? publicLeaderUrl(c.host.publicHost, c.host.port) : c.leaderUrl;
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

function tokenUnreadable(error: unknown): string {
  return `Could not read the stored agent token (${describe(error)}). Use "Disconnect this computer" in Settings and set up again.`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
