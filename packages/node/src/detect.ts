import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import type { AdapterConfig, AdapterType, AgentTrust, DetectedAgent } from '@quorum/protocol';

const BINARIES = { 'claude-code': 'claude', codex: 'codex', pi: 'pi', omp: 'omp', kilo: 'kilo', opencode: 'opencode' } as const;
const cache = new Map<string, Promise<DetectedAgent[]>>();

export function adapterTrust(type: AdapterType): AgentTrust {
  if (type === 'claude-code' || type === 'mock') return 'enforced';
  return type === 'codex' ? 'sandboxed' : 'low';
}

/** Discovery never starts a model turn. Executable paths are deliberately local. */
export async function detectAgents(
  adapter: AdapterConfig,
  options: { path?: string; timeoutMs?: number } = {},
): Promise<DetectedAgent[]> {
  try {
    const path = options.path ?? process.env.PATH ?? '';
    const binaryPath = 'binaryPath' in adapter ? adapter.binaryPath : undefined;
    const key = JSON.stringify([path, adapter.type, binaryPath, options.timeoutMs]);
    let pending = cache.get(key);
    if (pending === undefined) {
      pending = (async () => {
        const found = await Promise.all(Object.entries(BINARIES).map(async ([type, binary]) => {
          const candidates = path.split(delimiter).map((dir) => join(dir || '.', binary));
          if (type === adapter.type && binaryPath !== undefined) candidates.unshift(binaryPath);
          const versions = await Promise.all([...new Set(candidates)].map(async (candidate) => {
            try {
              await access(candidate, constants.X_OK);
              if (!(await stat(candidate)).isFile()) return null;
              return await versionOf(candidate, options.timeoutMs ?? 5000);
            } catch {
              return null;
            }
          }));
          const version = versions.find((value) => value !== null);
          return version === undefined ? [] : [{ type: type as AdapterType, version, trust: adapterTrust(type as AdapterType) }];
        }));
        return found.flat();
      })().catch(() => []);
      cache.set(key, pending);
    }
    return (await pending).map((agent) => ({ ...agent }));
  } catch {
    return [];
  }
}

function versionOf(binary: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(binary, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let output = '';
    let settled = false;
    const finish = (version: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(version);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null);
    }, timeoutMs);
    const collect = (chunk: Buffer) => {
      if (Buffer.byteLength(output) + chunk.length > 16384) {
        child.kill('SIGKILL');
        finish(null);
      } else output += chunk.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 ? output.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/)?.[0]?.slice(0, 100) ?? null : null));
  });
}
