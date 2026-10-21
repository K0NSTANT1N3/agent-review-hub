import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { cliSpawnOptions, type CliProcess, type SpawnFn } from '../../src/adapters/cli-process.js';
import type { AgentAdapter } from '../../src/adapters/types.js';

export class ReplayProcess extends EventEmitter implements CliProcess {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid?: number;
  signals: (NodeJS.Signals | number | undefined)[] = [];
  closeOn: NodeJS.Signals | null = 'SIGTERM';

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    if (signal === this.closeOn) queueMicrotask(() => this.emit('close', null, signal));
    return true;
  }

  replay(stdout: string, stderr = '', code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    const bytes = Buffer.from(stdout);
    for (let index = 0; index < bytes.length; index += 37) this.stdout.write(bytes.subarray(index, index + 37));
    this.stdout.end();
    this.stderr.end(stderr);
    queueMicrotask(() => this.emit('close', code, signal));
  }
}

export function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/agents/${name}.jsonl`, import.meta.url), 'utf8');
}

export function jsonLines(...events: unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n') + '\n';
}

export function replaySpawn(outputs: string[], stderr = '', code = 0): {
  spawnFn: SpawnFn;
  calls: Parameters<SpawnFn>[];
} {
  const calls: Parameters<SpawnFn>[] = [];
  const spawnFn: SpawnFn = (...args) => {
    calls.push(args);
    const child = new ReplayProcess();
    const output = outputs.shift() ?? '';
    queueMicrotask(() => child.replay(output, stderr, code));
    return child;
  };
  return { spawnFn, calls };
}

export function expectedSpawnOptions(cwd: string, env: NodeJS.ProcessEnv = process.env) {
  return cliSpawnOptions(cwd, env);
}

export function turn(adapter: AgentAdapter, over: Partial<Parameters<AgentAdapter['runTurn']>[0]> = {}) {
  return adapter.runTurn({
    nativeId: null, cwd: '/work/repo', profile: 'author', prompt: 'do it',
    signal: new AbortController().signal, timeoutMs: 10_000, ...over,
  });
}
