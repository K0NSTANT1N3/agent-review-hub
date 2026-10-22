import type { AdapterConfig, ApiResponse, ApiRouteName, LendMode, NodeStatus, UiEvent } from '@quorum/protocol';

// Contract between the Electron main process, the preload bridge and the renderer.
// The renderer never sees the agent token: REST calls and the /ws/ui stream are proxied by main.

export type Mode = 'host' | 'join';

/** Kind of network an address belongs to. Quorum works with any VPN; these are only labels. */
export type AddressKind = 'tailscale' | 'zerotier' | 'wireguard' | 'vpn' | 'local' | 'public';

export interface AddressOption {
  /** What goes into join codes (IP, or a stable name such as a Tailscale MagicDNS name). */
  address: string;
  /** Local IP the Leader binds to when connections are restricted to this address. */
  bindIp: string;
  kind: AddressKind;
  label: string;
  interfaceName: string;
  recommended: boolean;
}

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
  leader: { running: boolean; port: number | null; publicUrl: string | null; restrictedTo: string | null; error: string | null } | null;
  node: { running: boolean; error: string | null; status: NodeStatus | null };
  connected: boolean;
  /** http(s) base of the Leader this app talks to (what `quorum login --url` needs). */
  apiUrl: string | null;
  /** Whether teammates' connections to the Leader are encrypted (wss://). */
  encrypted: boolean;
  /** Network the Leader is reached through, to explain connection problems. */
  leaderNetwork: AddressKind | 'tunnel' | 'loopback' | null;
  /** Plaintext public connections are allowed and shown with this warning. */
  connectionWarning: string | null;
  /** Set when the Leader refuses this computer's token (revoked or rotated) or the stored token cannot be read. */
  authError: string | null;
  /** False when the agent token is stored as plain text because the OS has no keychain; null before setup. */
  secretsEncrypted: boolean | null;
  /** A start, stop, restart or setup is in progress. */
  busy: boolean;
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
  /** When set, the Leader accepts connections only on this local IP (e.g. the VPN address). */
  restrictToIp?: string | null;
  settings: DesktopSettings;
}

export interface JoinSetup {
  joinCode: string;
  settings: DesktopSettings;
}

export interface ResetOptions {
  /** Host only: also delete the Leader database and clone (all tasks and history). */
  deleteLeaderData?: boolean;
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
  reset(options?: ResetOptions): Promise<AppState>;
  networkAddresses(): Promise<AddressOption[]>;
  installCli(): Promise<string>;
  checkAgent(): Promise<{ ok: boolean; detail: string }>;
  /** Writes an API token and this app's Leader URL into the TUI-only login (tui.json); returns the file path. */
  saveTuiToken(token: string): Promise<string>;
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
  installCli: 'quorum:install-cli',
  checkAgent: 'quorum:check-agent',
  saveTuiToken: 'quorum:save-tui-token',
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
