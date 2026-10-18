import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { TestResult } from '@quorum/protocol';
import { assertGitSuccess, git } from '../git/git.js';
import { readProjectConfig } from './project-config.js';

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'go.sum', 'poetry.lock', 'Cargo.lock'];
const OUTPUT_LIMIT_BYTES = 20 * 1024;
const OUTPUT_LINE_LIMIT = 200;
const KILL_GRACE_MS = 500;

export interface SetupResult {
  ran: boolean;
  outputTail: string;
}

export async function runSetupIfNeeded(worktree: string, mainBranch = 'main'): Promise<SetupResult> {
  const config = await readProjectConfig(worktree, mainBranch);
  if (!config.setupCommand) return { ran: false, outputTail: 'no setupCommand configured' };

  const lockfileHash = await hashLockfiles(worktree);
  const statePath = await setupStatePath(worktree);
  if ((await readSavedHash(statePath)) === lockfileHash) return { ran: false, outputTail: '' };

  const outcome = await executeCommand(config.setupCommand, worktree, config.testTimeoutSec);
  if (outcome.timedOut) throw new Error(`setupCommand timed out after ${config.testTimeoutSec}s: ${outcome.outputTail}`);
  if (outcome.exitCode !== 0) throw new Error(`setupCommand exited with ${String(outcome.exitCode)}: ${outcome.outputTail}`);

  await mkdir(dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${lockfileHash}\n`, 'utf8');
  await rename(temporaryPath, statePath);
  return { ran: true, outputTail: outcome.outputTail };
}

export async function runTests(worktree: string, mainBranch = 'main'): Promise<TestResult> {
  const config = await readProjectConfig(worktree, mainBranch);
  if (!config.testCommand) {
    return {
      passed: true,
      exitCode: null,
      outputTail: 'no testCommand configured',
      durationMs: 0,
      timedOut: false,
    };
  }

  const outcome = await executeCommand(config.testCommand, worktree, config.testTimeoutSec);
  return {
    passed: !outcome.timedOut && outcome.exitCode === 0,
    exitCode: outcome.timedOut ? null : outcome.exitCode,
    outputTail: outcome.outputTail,
    durationMs: outcome.durationMs,
    timedOut: outcome.timedOut,
  };
}

async function hashLockfiles(worktree: string): Promise<string> {
  const hash = createHash('sha256');
  let found = false;
  for (const file of LOCKFILES) {
    try {
      const contents = await readFile(join(worktree, file));
      hash.update(file);
      hash.update('\0');
      hash.update(contents);
      hash.update('\0');
      found = true;
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
  if (!found) hash.update('no-lockfiles');
  return hash.digest('hex');
}

async function setupStatePath(worktree: string): Promise<string> {
  const result = await git(worktree, ['rev-parse', '--git-dir']);
  assertGitSuccess(result, 'locate worktree git metadata');
  const gitDir = resolve(worktree, result.stdout.trim());
  return join(gitDir, 'quorum-node', 'setup-lockfiles.sha256');
}

async function readSavedHash(path: string): Promise<string | null> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

async function executeCommand(command: string, cwd: string, timeoutSec: number): Promise<{
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  outputTail: string;
}> {
  const windows = process.platform === 'win32';
  const child = spawn(windows ? 'cmd.exe' : 'sh', windows ? ['/c', command] : ['-c', command], {
    cwd,
    detached: !windows,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const startedAt = Date.now();
  const tail = new OutputTail();
  child.stdout?.on('data', (chunk: Buffer | string) => tail.append(chunk));
  child.stderr?.on('data', (chunk: Buffer | string) => tail.append(chunk));

  let timedOut = false;
  let killTimer: NodeJS.Timeout | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    killProcessTree(child, windows);
    killTimer = setTimeout(() => killProcessTree(child, windows, true), KILL_GRACE_MS);
    killTimer.unref();
  }, timeoutSec * 1000);
  timeout.unref();

  return new Promise((resolvePromise) => {
    child.once('error', (error) => tail.append(`\n${error.message}\n`));
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolvePromise({
        exitCode: code,
        durationMs: Date.now() - startedAt,
        timedOut,
        outputTail: tail.toString(),
      });
    });
  });
}

function killProcessTree(child: ReturnType<typeof spawn>, windows: boolean, force = false): void {
  if (!child.pid) return;
  if (windows) {
    const args = ['/PID', String(child.pid), '/T'];
    if (force) args.push('/F');
    execFile('taskkill.exe', args, { windowsHide: true }, () => undefined);
    return;
  }

  try {
    process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    try {
      child.kill(force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      // The process may have exited between the timeout and the signal.
    }
  }
}

class OutputTail {
  private value = Buffer.alloc(0);

  append(chunk: Buffer | string): void {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.value = Buffer.concat([this.value, next]);
    if (this.value.length > OUTPUT_LIMIT_BYTES) this.value = this.value.subarray(-OUTPUT_LIMIT_BYTES);
  }

  toString(): string {
    const lines = this.value.toString('utf8').split(/\r?\n/).slice(-OUTPUT_LINE_LIMIT);
    const output = Buffer.from(lines.join('\n'), 'utf8');
    return (output.length > OUTPUT_LIMIT_BYTES ? output.subarray(-OUTPUT_LIMIT_BYTES) : output).toString('utf8');
  }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
