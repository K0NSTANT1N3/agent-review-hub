import { assertGitSuccess, git } from '../git/git.js';

export interface ProjectConfig {
  setupCommand: string | null;
  testCommand: string | null;
  testTimeoutSec: number;
}

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  setupCommand: null,
  testCommand: null,
  testTimeoutSec: 900,
};

/** Read execution settings only from the fetched main branch, never from task code. */
export async function readProjectConfig(worktree: string, mainBranch = 'main'): Promise<ProjectConfig> {
  assertBranchName(mainBranch);
  const ref = `origin/${mainBranch}`;
  const commit = await git(worktree, ['rev-parse', '--verify', `${ref}^{commit}`]);
  assertGitSuccess(commit, `verify project config ref ${ref}`);

  const entry = await git(worktree, ['ls-tree', '--name-only', '-z', ref, '--', 'quorum.json']);
  assertGitSuccess(entry, `check for quorum.json on ${ref}`);
  if (!entry.stdout.split('\0').includes('quorum.json')) return { ...DEFAULT_PROJECT_CONFIG };

  const shown = await git(worktree, ['show', `${ref}:quorum.json`]);
  assertGitSuccess(shown, `read quorum.json from ${ref}`);
  return parseProjectConfig(shown.stdout);
}

function parseProjectConfig(contents: string): ProjectConfig {
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch (error) {
    throw new Error(`Invalid quorum.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid quorum.json: expected a JSON object');
  }

  const record = value as Record<string, unknown>;
  const setupCommand = optionalCommand(record.setupCommand, 'setupCommand');
  const testCommand = optionalCommand(record.testCommand, 'testCommand');
  const timeout = record.testTimeoutSec ?? DEFAULT_PROJECT_CONFIG.testTimeoutSec;
  if (!Number.isInteger(timeout) || typeof timeout !== 'number' || timeout <= 0) {
    throw new Error('Invalid quorum.json: testTimeoutSec must be a positive integer');
  }

  return { setupCommand, testCommand, testTimeoutSec: timeout };
}

function optionalCommand(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid quorum.json: ${name} must be a non-empty string when supplied`);
  }
  return value;
}

function assertBranchName(branch: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..') || branch.includes('//')) {
    throw new Error(`Invalid main branch name: ${branch}`);
  }
}
