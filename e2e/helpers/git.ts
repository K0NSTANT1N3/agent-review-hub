import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const IDENTITY = ['-c', 'user.name=quorum-e2e', '-c', 'user.email=e2e@quorum.invalid'];

/** Runs git and returns trimmed stdout; throws with stderr on failure. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', [...IDENTITY, ...args], { cwd, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    const e = error as { stderr?: string; message: string };
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${e.stderr ?? e.message}`);
  }
}

/** Like git() but returns null instead of throwing. */
export async function gitMaybe(cwd: string, ...args: string[]): Promise<string | null> {
  try {
    return await git(cwd, ...args);
  } catch {
    return null;
  }
}
