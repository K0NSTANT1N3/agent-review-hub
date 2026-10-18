import type { AdapterConfig, ApiResponse, ApiRouteName, LendMode, NodeStatus, UiEvent } from '@quorum/protocol';

// Contract between the Electron main process, the preload bridge and the renderer.
// The renderer never sees the agent token: REST calls and the /ws/ui stream are proxied by main.

export type Mode = 'host' | 'join';

export interface DesktopSettings {
  adapter: AdapterConfig;
  maxSessions: number;
  lendMode: LendMode;
  lendTokensPerDay: number;
  idleThresholdSec: number;
  paused: boolean;
  tags: string[];
}

export interface AppState {
  configured: boolean;
  mode: Mode | null;
  ownerName: string | null;
  agentId: string | null;
  repoRemoteUrl: string | null;
  isAdmin: boolean;
  leader: { running: boolean; port: number | null; publicUrl: string | null; error: string | null } | null;
  node: { running: boolean; error: string | null; status: NodeStatus | null };
  connected: boolean;
  settings: DesktopSettings | null;
  dataDir: string;
}

export interface HostSetup {
  ownerName: string;
  repoRemoteUrl: string;
  mainBranch: string;
  port: number;
  /** Host name or IP teammates use to reach this machine. */
  publicHost: string;
  settings: DesktopSettings;
}

export interface JoinSetup {
  joinCode: string;
  settings: DesktopSettings;
}

export interface ApiCallOptions {
  id?: number | string;
  query?: Record<string, string>;
  body?: unknown;
}

export type ApiResult<R extends ApiRouteName> =
  | { ok: true; data: ApiResponse<R> }
  | { ok: false; status: number; error: string; message: string };

export interface QuorumBridge {
  getState(): Promise<AppState>;
  setupHost(setup: HostSetup): Promise<AppState>;
  setupJoin(setup: JoinSetup): Promise<AppState>;
  invite(args: { agentId: string; ownerName: string }): Promise<{ joinCode: string }>;
  updateSettings(settings: DesktopSettings): Promise<AppState>;
  restart(): Promise<AppState>;
  reset(): Promise<AppState>;
  networkAddresses(): Promise<string[]>;
  openExternal(url: string): Promise<void>;
  api<R extends ApiRouteName>(route: R, options?: ApiCallOptions): Promise<ApiResult<R>>;
  onState(listener: (state: AppState) => void): () => void;
  onUiEvent(listener: (event: UiEvent) => void): () => void;
}

export const IPC = {
  getState: 'quorum:get-state',
  setupHost: 'quorum:setup-host',
  setupJoin: 'quorum:setup-join',
  invite: 'quorum:invite',
  updateSettings: 'quorum:update-settings',
  restart: 'quorum:restart',
  reset: 'quorum:reset',
  networkAddresses: 'quorum:network-addresses',
  openExternal: 'quorum:open-external',
  api: 'quorum:api',
  state: 'quorum:state',
  uiEvent: 'quorum:ui-event',
} as const;

export const DEFAULT_SETTINGS: DesktopSettings = {
  adapter: { type: 'claude-code', contextWindow: 200000 },
  maxSessions: 2,
  lendMode: 'when_idle',
  lendTokensPerDay: 2_000_000,
  idleThresholdSec: 300,
  paused: false,
  tags: [],
};
