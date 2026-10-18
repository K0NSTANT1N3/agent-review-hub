import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as leaderPkg from '@quorum/leader';
import * as nodePkg from '@quorum/node';
import {
  parseLeaderConfig,
  parseNodeConfig,
  type LeaderConfig,
  type LeaderConfigInput,
  type NodeConfig,
  type NodeConfigInput,
} from '@quorum/protocol';
import { Api } from './api.js';
import type { MockScript } from './mock-script.js';
import { createToyRemote } from './toy-project.js';

type LeaderHandle = Awaited<ReturnType<typeof leaderPkg.startLeader>>;
type DaemonHandle = Awaited<ReturnType<typeof nodePkg.startDaemon>>;

/**
 * True once both the Leader and Node implementations have replaced their C0 stubs.
 * Scenarios use `describe.skipIf(!E2E_READY)`. Set QUORUM_E2E=1 to run them anyway.
 */
export const E2E_READY =
  process.env.QUORUM_E2E === '1' ||
  (!/not implemented yet/.test(String(leaderPkg.startLeader)) && !/not implemented yet/.test(String(nodePkg.startDaemon)));

/** Fast timeouts so liveness scenarios finish in seconds. */
export const FAST_TIMEOUTS = {
  heartbeatIntervalSec: 1,
  agentOfflineAfterSec: 3,
  leaseSec: 4,
  authorReconnectGraceSec: 6,
  turnTimeoutSec: 60,
  resendUnackedSec: 1,
  idleSessionTtlMin: 60,
  noReviewerNotifyAfterSec: 5,
  mergeTestTimeoutSec: 60,
} as const;

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') return reject(new Error('no port'));
      srv.close(() => resolve(addr.port));
    });
  });
}

export interface AgentSpec {
  id: string;
  owner?: string;
  script: MockScript;
  /** Overrides on top of harness defaults (lendMode 'always', large budget, maxSessions 2). */
  config?: Partial<Omit<NodeConfigInput, 'adapter'>>;
  /** Mock adapter context window (default 200000); small values force compaction. */
  contextWindow?: number;
}

export interface Agent {
  id: string;
  owner: string;
  token: string;
  api: Api;
  config: NodeConfig;
  daemon: DaemonHandle | null;
}

export class Harness {
  private leader: LeaderHandle | null = null;
  readonly agents = new Map<string, Agent>();

  private constructor(
    readonly dir: string,
    readonly bare: string,
    readonly port: number,
    readonly leaderConfig: LeaderConfig,
  ) {}

  static async create(overrides: Partial<LeaderConfigInput> = {}): Promise<Harness> {
    const dir = await mkdtemp(join(tmpdir(), 'quorum-e2e-'));
    const bare = await createToyRemote(dir);
    const port = await freePort();
    await mkdir(join(dir, 'leader'), { recursive: true });
    const input: LeaderConfigInput = {
      ...overrides,
      listen: { host: '127.0.0.1', port },
      dbPath: join(dir, 'leader', 'leader.db'),
      repo: { remoteUrl: bare, clonePath: join(dir, 'leader', 'repo'), ...overrides.repo },
      admins: overrides.admins ?? ['admin'],
      timeouts: { ...FAST_TIMEOUTS, ...overrides.timeouts },
      scheduler: { tickMs: 100, ...overrides.scheduler },
    };
    return new Harness(dir, bare, port, parseLeaderConfig(input));
  }

  get httpUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async startLeader(): Promise<void> {
    if (this.leader !== null) throw new Error('leader already running');
    this.leader = await leaderPkg.startLeader(this.leaderConfig);
  }

  async stopLeader(): Promise<void> {
    await this.leader?.close();
    this.leader = null;
  }

  async restartLeader(downtimeMs = 500): Promise<void> {
    await this.stopLeader();
    await new Promise((r) => setTimeout(r, downtimeMs));
    await this.startLeader();
  }

  /** Registers the agent with the Leader DB and (by default) starts its Node daemon. */
  async addAgent(spec: AgentSpec, { start = true } = {}): Promise<Agent> {
    const owner = spec.owner ?? spec.id.split('-')[0] ?? spec.id;
    const { token } = await leaderPkg.addAgent(this.leaderConfig.dbPath, { id: spec.id, owner });
    const agentDir = join(this.dir, 'nodes', spec.id);
    await mkdir(agentDir, { recursive: true });
    const scriptPath = join(agentDir, 'mock-script.json');
    await writeFile(scriptPath, JSON.stringify(spec.script, null, 2));
    const input: NodeConfigInput = {
      leaderUrl: `ws://127.0.0.1:${this.port}/ws/node`,
      agentId: spec.id,
      token,
      ownerName: owner,
      dataDir: join(agentDir, 'data'),
      workspaceDir: join(agentDir, 'workspace'),
      repoRemoteUrl: this.bare,
      gitIdentity: { name: `${spec.id} (quorum)`, email: `${spec.id}@quorum.invalid` },
      adapter: { type: 'mock', scriptPath, contextWindow: spec.contextWindow ?? 200_000 },
      maxSessions: 2,
      lendMode: 'always',
      idleThresholdSec: 0,
      lendTokensPerDay: 100_000_000,
      ...spec.config,
    };
    const agent: Agent = { id: spec.id, owner, token, api: new Api(this.httpUrl, token), config: parseNodeConfig(input), daemon: null };
    this.agents.set(spec.id, agent);
    if (start) await this.startNode(spec.id);
    return agent;
  }

  agent(id: string): Agent {
    const a = this.agents.get(id);
    if (a === undefined) throw new Error(`unknown agent ${id}`);
    return a;
  }

  async startNode(id: string): Promise<void> {
    const a = this.agent(id);
    if (a.daemon !== null) throw new Error(`node ${id} already running`);
    a.daemon = await nodePkg.startDaemon(a.config, { idleSeconds: () => 1_000_000 });
  }

  /** Simulates a crash/disconnect of the agent's machine. */
  async stopNode(id: string): Promise<void> {
    const a = this.agent(id);
    await a.daemon?.stop();
    a.daemon = null;
  }

  /** Admin API client (owner listed in leader `admins`), registered on first use. */
  async adminApi(): Promise<Api> {
    const existing = this.agents.get('admin-console');
    if (existing !== undefined) return existing.api;
    const { token } = await leaderPkg.addAgent(this.leaderConfig.dbPath, { id: 'admin-console', owner: 'admin' });
    const api = new Api(this.httpUrl, token);
    this.agents.set('admin-console', { id: 'admin-console', owner: 'admin', token, api, config: null as never, daemon: null });
    return api;
  }

  async close(): Promise<void> {
    for (const a of this.agents.values()) {
      try {
        await a.daemon?.stop();
      } catch {
        // best effort
      }
    }
    try {
      await this.stopLeader();
    } finally {
      if (process.env.QUORUM_E2E_KEEP !== '1') await rm(this.dir, { recursive: true, force: true });
    }
  }
}

/** Common topology: author `alice-claude` (never lends) and reviewer `bob-claude`. */
export async function aliceAndBob(
  h: Harness,
  scripts: { alice: MockScript; bob: MockScript },
  config: { alice?: AgentSpec['config']; bob?: AgentSpec['config'] } = {},
): Promise<{ alice: Agent; bob: Agent }> {
  await h.startLeader();
  const alice = await h.addAgent({ id: 'alice-claude', script: scripts.alice, config: { lendMode: 'never', ...config.alice } });
  const bob = await h.addAgent({ id: 'bob-claude', script: scripts.bob, config: config.bob ?? {} });
  return { alice, bob };
}
