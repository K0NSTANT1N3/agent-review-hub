import type { AdapterConfig } from '@quorum/protocol';

export const CLI_ADAPTER_TYPES = ['codex', 'pi', 'omp', 'kilo'] as const;
export type CliAdapterType = (typeof CLI_ADAPTER_TYPES)[number];

export const CLI_ADAPTER_TRUST_NOTE: Record<CliAdapterType, string> = {
  codex: 'Sandboxed by Codex; writes limited to the worktree.',
  pi: 'Low trust: Quorum cannot enforce tool limits.',
  omp: 'Low trust: Quorum cannot enforce tool limits.',
  kilo: 'Low trust: Kilo applies read-only permission rules; no OS sandbox.',
};

export function isCliAdapter(adapter: AdapterConfig): adapter is Extract<AdapterConfig, { type: CliAdapterType }> {
  return adapter.type === 'codex' || adapter.type === 'pi' || adapter.type === 'omp' || adapter.type === 'kilo';
}

export function settingsAdapter(type: AdapterConfig['type'], contextWindow = 200000): AdapterConfig {
  if (type === 'opencode') {
    return { type, baseUrl: 'http://localhost:4096', providerID: 'anthropic', modelID: 'claude-sonnet-5-5', contextWindow };
  }
  if (type === 'custom') throw new Error('Custom adapters require profile commands and a JSONL mapping in the Node config.');
  if (type === 'mock') return { type, scriptPath: '', contextWindow };
  return { type, contextWindow };
}
