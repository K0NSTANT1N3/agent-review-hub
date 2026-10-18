import type { NodeConfig, NodeStatus, OwnerSettings } from '@quorum/protocol';
import type { AgentAdapter } from './adapters/types.js';

export type { AgentAdapter, Profile, TurnResult } from './adapters/types.js';
export { AdapterError } from './adapters/types.js';

export interface DaemonHandle {
  stop(): Promise<void>;
  status(): NodeStatus;
  updateSettings(patch: Partial<OwnerSettings>): void;
}

export interface StartDaemonOptions {
  /** Desktop passes powerMonitor; headless omits. */
  idleSeconds?: () => number | null;
  /** Tests may inject; otherwise built from config.adapter. */
  adapter?: AgentAdapter;
}

// Stub from scaffold C0 — implemented by Codex-2 in N8.
export async function startDaemon(_config: NodeConfig, _opts?: StartDaemonOptions): Promise<DaemonHandle> {
  throw new Error('startDaemon: not implemented yet (N8)');
}
