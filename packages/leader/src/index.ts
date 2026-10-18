import type { LeaderConfig } from '@quorum/protocol';

export interface LeaderHandle {
  /** Actual bound port (config may pass 0). */
  port: number;
  /** e.g. "ws://127.0.0.1:54321" */
  url: string;
  /** Stops scheduler, merge worker and servers; closes the DB. */
  close(): Promise<void>;
}

// Stub from scaffold C0 — implemented by Codex-1 in L9.
export async function startLeader(_config: LeaderConfig): Promise<LeaderHandle> {
  throw new Error('startLeader: not implemented yet (L9)');
}

// Stub from scaffold C0 — implemented by Codex-1 in L8.
export async function addAgent(_dbPath: string, _args: { id: string; owner: string }): Promise<{ token: string }> {
  throw new Error('addAgent: not implemented yet (L8)');
}
