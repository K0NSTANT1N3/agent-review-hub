import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseProjectConfig, type LeaderConfig, type ProjectConfig, type TestResult } from '@quorum/protocol';
import { silentLogger, type Logger } from '../logging.js';

// Spec §14.3 / §6.3. All git calls use execFile with argument arrays and a 5-minute timeout.

const GIT_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_TAIL_LINES = 200;
const OUTPUT_TAIL_BYTES = 20 * 1024;
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'go.sum', 'poetry.lock', 'Cargo.lock'];
export const LEADER_IDENTITY = ['-c', 'user.name=quorum-leader', '-c', 'user.email=quorum@localhost'];

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function tail(text: string): string {
  const lines = text.split('\n');
  let out = lines.slice(-OUTPUT_TAIL_LINES).join('\n');
  if (Buffer.byteLength(out) > OUTPUT_TAIL_BYTES) out = Buffer.from(out).subarray(-OUTPUT_TAIL_BYTES).toString();
  return out;
}

/** Runs a project command (setup/test) through the platform shell, killing the whole process tree on timeout. */
export function runShell(command: string, cwd: string, timeoutMs: number): Promise<TestResult> {
  const started = Date.now();
  return new Promise((done) => {
    const isWin = process.platform === 'win32';
    const child = spawn(isWin ? 'cmd' : 'sh', isWin ? ['/c', command] : ['-c', command], {
      cwd,
      detached: !isWin,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1' },
    });
    let output = '';
    const append = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 4 * OUTPUT_TAIL_BYTES) output = output.slice(-2 * OUTPUT_TAIL_BYTES);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
        else if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      done({ passed: false, exitCode: null, outputTail: tail(`${output}\n${error.message}`), durationMs: Date.now() - started, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({
        passed: !timedOut && code === 0,
        exitCode: code,
        outputTail: tail(timedOut ? `${output}\n[timed out after ${timeoutMs}ms]` : output),
        durationMs: Date.now() - started,
        timedOut,
      });
    });
  });
}

export class LeaderGit {
  readonly clonePath: string;
  private chain: Promise<unknown> = Promise.resolve();
  private lastSetupHash: string | null = null;

  constructor(
    private readonly repo: LeaderConfig['repo'],
    private readonly log: Logger = silentLogger,
  ) {
    this.clonePath = resolve(repo.clonePath);
  }

  get mainRef(): string {
    return `origin/${this.repo.mainBranch}`;
  }

  /** Serializes clone mutations (merge worker vs. diff endpoint vs. branch deletion). */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  run(args: string[], cwd = this.clonePath): Promise<GitResult> {
    return new Promise((done) => {
      execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        done({ code, stdout: stdout.toString(), stderr: stderr.toString() || (error?.message ?? '') });
      });
    });
  }

  async must(args: string[]): Promise<string> {
    const r = await this.run(args);
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
    return r.stdout.trim();
  }

  async ensureClone(): Promise<void> {
    if (existsSync(join(this.clonePath, '.git'))) return;
    await mkdir(dirname(this.clonePath), { recursive: true });
    const r = await this.run(['clone', this.repo.remoteUrl, this.clonePath], dirname(this.clonePath));
    if (r.code !== 0) throw new Error(`git clone ${this.repo.remoteUrl} failed: ${r.stderr.trim()}`);
    this.log.info({ clonePath: this.clonePath }, 'leader clone created');
  }

  async fetch(): Promise<void> {
    await this.ensureClone();
    await this.must(['fetch', 'origin', '--prune']);
  }

  /** File content on origin/<main>, or null when absent. */
  async readMain(path: string): Promise<string | null> {
    const r = await this.run(['show', `${this.mainRef}:${path}`]);
    return r.code === 0 ? r.stdout : null;
  }

  /** quorum.json is always read from main, never from a task branch (spec §6.3, §19.4). */
  async projectConfig(): Promise<ProjectConfig> {
    const raw = await this.readMain('quorum.json');
    if (raw === null) return parseProjectConfig({});
    try {
      return parseProjectConfig(JSON.parse(raw));
    } catch (error) {
      this.log.warn({ err: error }, 'invalid quorum.json on main; using defaults');
      return parseProjectConfig({});
    }
  }

  async diff(from: string, to: string): Promise<string> {
    await this.fetch();
    return this.must(['diff', from, to]);
  }

  async deleteRemoteBranch(branch: string): Promise<void> {
    await this.ensureClone();
    const r = await this.run(['push', 'origin', '--delete', branch]);
    if (r.code !== 0 && !/remote ref does not exist|unable to delete/i.test(r.stderr)) {
      this.log.warn({ branch, stderr: r.stderr }, 'branch deletion failed');
    }
  }

  async revParse(ref: string): Promise<string> {
    return this.must(['rev-parse', ref]);
  }

  /** Runs setupCommand when the lockfile content changed since the last run. */
  async setupIfNeeded(config: ProjectConfig): Promise<TestResult | null> {
    if (config.setupCommand === null) return null;
    const hash = createHash('sha256');
    for (const f of LOCKFILES) {
      const p = join(this.clonePath, f);
      if (existsSync(p)) hash.update(f).update(await readFile(p));
    }
    const digest = hash.digest('hex');
    if (digest === this.lastSetupHash) return null;
    const result = await runShell(config.setupCommand, this.clonePath, config.testTimeoutSec * 1000);
    if (result.passed) this.lastSetupHash = digest;
    return result;
  }
}
