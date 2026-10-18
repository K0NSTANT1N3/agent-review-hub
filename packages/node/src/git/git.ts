import { execFile as execFileCallback } from 'node:child_process';
import type { ExecFileException } from 'node:child_process';

export interface GitIdentity {
  name: string;
  email: string;
}

export interface GitOptions {
  timeoutMs?: number;
  identity?: GitIdentity;
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class GitExecutionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'GitExecutionError';
  }
}

export class GitTimeoutError extends GitExecutionError {
  constructor(cwd: string, args: readonly string[], timeoutMs: number) {
    super(`git ${args.join(' ')} timed out after ${timeoutMs}ms in ${cwd}`);
    this.name = 'GitTimeoutError';
  }
}

/** Run git without a shell. Non-zero git exit codes are returned to the caller. */
export function git(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<GitResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const commandArgs = [...args];

  if (commandArgs[0] === 'commit' && options.identity) {
    commandArgs.unshift(
      '-c', `user.name=${options.identity.name}`,
      '-c', `user.email=${options.identity.email}`,
    );
  }

  return new Promise((resolve, reject) => {
    execFileCallback(
      'git',
      commandArgs,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error: ExecFileException | null, stdout: string, stderr: string) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr });
          return;
        }

        if (typeof error.code === 'number') {
          resolve({ code: error.code, stdout, stderr });
          return;
        }

        if (error.killed || error.signal) {
          reject(new GitTimeoutError(cwd, args, timeoutMs));
          return;
        }

        reject(new GitExecutionError(`Could not run git in ${cwd}: ${error.message}`, { cause: error }));
      },
    );
  });
}

export function assertGitSuccess(result: GitResult, operation: string): void {
  if (result.code !== 0) {
    const details = result.stderr.trim() || result.stdout.trim();
    throw new GitExecutionError(`${operation} failed${details ? `: ${details}` : ''}`);
  }
}
