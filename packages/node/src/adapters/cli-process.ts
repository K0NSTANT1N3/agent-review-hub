import { execFile, spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { AdapterError } from './types.js';

export const MAX_JSONL_LINE_BYTES = 2 * 1024 * 1024;

export interface CliProcess extends Pick<ChildProcess, 'kill'> {
  readonly pid?: number;
  stdout: Readable;
  stderr: Readable;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export interface CliSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdio: ['ignore', 'pipe', 'pipe'];
  detached: boolean;
  windowsHide: boolean;
  shell: false;
}

export type SpawnFn = (
  binary: string,
  argv: readonly string[],
  options: CliSpawnOptions,
) => CliProcess;

export interface CliProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  malformedLineCount: number;
  malformedLines: string[];
}

export function cliSpawnOptions(cwd: string, env: NodeJS.ProcessEnv): CliSpawnOptions {
  return {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
    shell: false,
  };
}

/** SIGTERM (or taskkill) the process group, then SIGKILL if it is still alive. */
export function killCliProcess(child: CliProcess, force = false): void {
  const windows = process.platform === 'win32';
  if (windows) {
    if (child.pid) {
      const args = ['/PID', String(child.pid), '/T'];
      if (force) args.push('/F');
      execFile('taskkill.exe', args, { windowsHide: true }, () => undefined);
      return;
    }
  } else if (child.pid) {
    try {
      process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
      return;
    } catch {
      // The process group may have exited; fall through to the child pid.
    }
  }
  try {
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    // The process may have exited between the timeout and the signal.
  }
}

/** One non-interactive CLI turn. Completion waits for close, including after cancellation. */
export async function runCliProcess(options: {
  binary: string;
  argv: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs: number;
  onJson: (value: unknown) => void;
  spawnFn?: SpawnFn;
}): Promise<CliProcessResult> {
  if (options.signal.aborted) throw new AdapterError('CANCELLED');
  if (options.timeoutMs <= 0) throw new AdapterError('TIMEOUT');
  const spawnOpts = cliSpawnOptions(options.cwd, options.env ?? process.env);
  const spawnFn: SpawnFn = options.spawnFn ?? ((binary, argv, opts) => spawn(binary, argv, opts));
  let child: CliProcess;
  try {
    child = spawnFn(options.binary, options.argv, spawnOpts);
  } catch (error) {
    throw new AdapterError('ADAPTER_ERROR', String(error), { cause: error });
  }

  return new Promise((resolve, reject) => {
    let pending = '';
    let stderr = Buffer.alloc(0);
    let malformedLineCount = 0;
    const malformedLines: string[] = [];
    let failure: unknown;
    let stopped = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    function stop(error: unknown): void {
      if (stopped || settled) return;
      stopped = true;
      failure = error;
      killTimer = setTimeout(() => killCliProcess(child, true), 5_000);
      killCliProcess(child, false);
    }

    function line(value: string): void {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value.replaceAll('\0', '')) as unknown;
      } catch {
        malformedLineCount++;
        malformedLines.push(value.replaceAll('\0', ''));
        if (malformedLines.length > 20) malformedLines.shift();
        return;
      }
      if (stopped) return;
      try {
        options.onJson(parsed);
      } catch (error) {
        stop(error);
      }
    }

    function finish(code: number | null, signal: NodeJS.Signals | null, error?: Error): void {
      if (settled) return;
      if (pending.length > 0) line(pending);
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      options.signal.removeEventListener('abort', aborted);
      if (failure !== undefined || error !== undefined) {
        const cause = failure ?? error;
        reject(cause instanceof AdapterError ? cause : new AdapterError('ADAPTER_ERROR', String(cause), { cause }));
        return;
      }
      // The byte tail can start in the middle of a UTF-8 character.
      let start = 0;
      while (start < stderr.length && (stderr[start]! & 0xc0) === 0x80) start++;
      resolve({ code, signal, stderr: stderr.subarray(start).toString('utf8'), malformedLineCount, malformedLines });
    }

    const aborted = () => stop(new AdapterError('CANCELLED'));
    const timeout = setTimeout(() => stop(new AdapterError('TIMEOUT')), options.timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stopped || settled) return;
      pending += chunk;
      let end: number;
      while ((end = pending.indexOf('\n')) !== -1) {
        const value = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (Buffer.byteLength(value) > MAX_JSONL_LINE_BYTES) {
          stop(new AdapterError('ADAPTER_ERROR', 'agent output line exceeded 2 MiB'));
          pending = '';
          return;
        }
        line(value);
      }
      if (Buffer.byteLength(pending) > MAX_JSONL_LINE_BYTES) {
        stop(new AdapterError('ADAPTER_ERROR', 'agent output line exceeded 2 MiB'));
        pending = '';
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]).subarray(-8_192);
    });
    child.stdout.once('error', stop);
    child.stderr.once('error', stop);
    child.once('error', (error: Error) => finish(null, null, error));
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => finish(code, signal));
    options.signal.addEventListener('abort', aborted, { once: true });
    if (options.signal.aborted) aborted();
  });
}
