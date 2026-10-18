import { access, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertGitSuccess, git, type GitIdentity } from './git.js';

export interface WorktreeConfig {
  workspaceDir: string;
  repoRemoteUrl: string;
  mainBranch: string;
  gitIdentity: GitIdentity;
  gitTimeoutMs?: number;
}

export interface DiffInfo {
  filesChanged: string[];
  diffLines: number;
}

export interface SyncResult {
  hadConflicts: boolean;
  conflictedFiles: string[];
}

export class ConflictResolutionError extends Error {
  constructor(readonly files: string[], message: string) {
    super(message);
    this.name = 'ConflictResolutionError';
  }
}

export function baseClonePath(config: WorktreeConfig): string {
  return join(config.workspaceDir, 'repo');
}

export function worktreePath(config: WorktreeConfig, sid: string): string {
  assertSessionId(sid);
  return join(config.workspaceDir, 'worktrees', sid);
}

export async function ensureBaseClone(config: WorktreeConfig): Promise<string> {
  const repoPath = baseClonePath(config);
  await mkdir(config.workspaceDir, { recursive: true });

  if (!(await exists(repoPath))) {
    const result = await git(config.workspaceDir, ['clone', config.repoRemoteUrl, repoPath], options(config));
    assertGitSuccess(result, 'clone repository');
  }

  // `remote get-url` applies url.<base>.insteadOf rewriting; compare the URL that was actually configured.
  const actualRemote = await git(repoPath, ['config', '--get', 'remote.origin.url'], options(config));
  assertGitSuccess(actualRemote, 'read origin URL');
  if (actualRemote.stdout.trim() !== config.repoRemoteUrl) {
    throw new Error(`Existing base clone uses ${actualRemote.stdout.trim()}, expected ${config.repoRemoteUrl}`);
  }

  const validRepo = await git(repoPath, ['rev-parse', '--git-dir'], options(config));
  assertGitSuccess(validRepo, 'verify base clone');
  return repoPath;
}

export async function createWorktree(config: WorktreeConfig, sid: string): Promise<string> {
  const repoPath = await ensureBaseClone(config);
  const target = worktreePath(config, sid);
  await mkdir(dirname(target), { recursive: true });

  if (await exists(target)) {
    const existingRoot = await git(target, ['rev-parse', '--show-toplevel'], options(config));
    assertGitSuccess(existingRoot, `verify worktree for session ${sid}`);
    // Compare real paths: git reports the symlink-resolved root (macOS /var -> /private/var).
    if ((await realpath(existingRoot.stdout.trim())) !== (await realpath(target))) {
      throw new Error(`Session path ${target} is already occupied by a different directory`);
    }
    return target;
  }

  const fetched = await git(repoPath, ['fetch', 'origin', '--prune'], options(config));
  assertGitSuccess(fetched, 'fetch origin before creating worktree');
  const added = await git(repoPath, [
    'worktree', 'add', '--detach', target, `origin/${config.mainBranch}`,
  ], options(config));
  assertGitSuccess(added, `create worktree for session ${sid}`);
  return target;
}

export async function prepareAuthorNewBranch(
  config: WorktreeConfig,
  sid: string,
  branch: string,
): Promise<string> {
  assertTaskBranch(branch);
  const cwd = worktreePath(config, sid);
  const fetched = await git(cwd, ['fetch', 'origin', '--prune'], options(config));
  assertGitSuccess(fetched, 'fetch origin before author turn');
  const checkout = await git(cwd, ['checkout', '-B', branch, `origin/${config.mainBranch}`], options(config));
  assertGitSuccess(checkout, `prepare new author branch ${branch}`);
  const base = await git(cwd, ['rev-parse', 'HEAD'], options(config));
  assertGitSuccess(base, 'read author base commit');
  const pushed = await git(cwd, ['push', '-u', 'origin', branch], options(config));
  assertGitSuccess(pushed, `publish author branch ${branch}`);
  return base.stdout.trim();
}

export async function prepareAuthorExistingBranch(
  config: WorktreeConfig,
  sid: string,
  branch: string,
): Promise<string> {
  assertTaskBranch(branch);
  const cwd = worktreePath(config, sid);
  const fetched = await git(cwd, ['fetch', 'origin', '--prune'], options(config));
  assertGitSuccess(fetched, 'fetch origin before resuming author branch');
  const checkout = await git(cwd, ['checkout', '-B', branch, `origin/${branch}`], options(config));
  assertGitSuccess(checkout, `resume author branch ${branch}`);
  const base = await git(cwd, ['merge-base', 'HEAD', `origin/${config.mainBranch}`], options(config));
  assertGitSuccess(base, 'find original author base commit');
  return base.stdout.trim();
}

export async function ensureCleanBeforeAuthorTurn(config: WorktreeConfig, sid: string): Promise<void> {
  const cwd = worktreePath(config, sid);
  const status = await git(cwd, ['status', '--porcelain'], options(config));
  assertGitSuccess(status, 'check worktree before author turn');
  if (status.stdout.length === 0) return;

  const staged = await git(cwd, ['add', '-A'], options(config));
  assertGitSuccess(staged, 'stage recovered author changes');
  const committed = await git(cwd, ['commit', '-m', 'quorum: recovered uncommitted changes'], commitOptions(config));
  assertGitSuccess(committed, 'commit recovered author changes');
}

export async function commitAndPushAfterAuthorTurn(
  config: WorktreeConfig,
  sid: string,
  branch: string,
  taskId: number,
  turn: number,
): Promise<string | null> {
  assertTaskBranch(branch);
  const cwd = worktreePath(config, sid);
  const staged = await git(cwd, ['add', '-A'], options(config));
  assertGitSuccess(staged, 'stage author changes');
  const changed = await git(cwd, ['diff', '--cached', '--quiet'], options(config));
  if (changed.code !== 0 && changed.code !== 1) assertGitSuccess(changed, 'check staged author changes');

  let commit: string | null = null;
  if (changed.code === 1) {
    const committed = await git(cwd, ['commit', '-m', `quorum task #${taskId}: turn ${turn}`], commitOptions(config));
    assertGitSuccess(committed, 'commit author turn');
    const head = await git(cwd, ['rev-parse', 'HEAD'], options(config));
    assertGitSuccess(head, 'read author turn commit');
    commit = head.stdout.trim();
  }

  const pushed = await git(cwd, ['push', 'origin', branch], options(config));
  assertGitSuccess(pushed, `push author branch ${branch}`);
  return commit;
}

export async function diffInfo(config: WorktreeConfig, sid: string, base: string): Promise<DiffInfo> {
  const cwd = worktreePath(config, sid);
  const names = await git(cwd, ['diff', '--name-only', '-z', `${base}...HEAD`], options(config));
  assertGitSuccess(names, 'list changed files');
  const stats = await git(cwd, ['diff', '--numstat', '-z', `${base}...HEAD`], options(config));
  assertGitSuccess(stats, 'calculate diff size');

  const filesChanged = names.stdout.split('\0').filter(Boolean);
  let diffLines = 0;
  for (const record of stats.stdout.split('\0')) {
    if (record.length === 0) continue;
    const firstTab = record.indexOf('\t');
    const secondTab = record.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const added = Number(record.slice(0, firstTab));
    const deleted = Number(record.slice(firstTab + 1, secondTab));
    if (Number.isFinite(added)) diffLines += added;
    if (Number.isFinite(deleted)) diffLines += deleted;
  }
  return { filesChanged, diffLines };
}

export async function prepareReviewer(config: WorktreeConfig, sid: string, headCommit: string): Promise<void> {
  const cwd = worktreePath(config, sid);
  const fetched = await git(cwd, ['fetch', 'origin', '--prune'], options(config));
  assertGitSuccess(fetched, 'fetch before preparing reviewer');
  const checkout = await git(cwd, ['checkout', '--detach', headCommit], options(config));
  assertGitSuccess(checkout, `checkout reviewer commit ${headCommit}`);
  const cleaned = await git(cwd, ['clean', '-fd'], options(config));
  assertGitSuccess(cleaned, 'clean reviewer worktree');
}

export async function resetIfReviewerModified(config: WorktreeConfig, sid: string): Promise<boolean> {
  const cwd = worktreePath(config, sid);
  const status = await git(cwd, ['status', '--porcelain'], options(config));
  assertGitSuccess(status, 'check reviewer worktree');
  if (status.stdout.length === 0) return false;

  const reset = await git(cwd, ['reset', '--hard'], options(config));
  assertGitSuccess(reset, 'reset reviewer changes');
  const cleaned = await git(cwd, ['clean', '-fd'], options(config));
  assertGitSuccess(cleaned, 'remove files created by reviewer');
  return true;
}

export async function syncWithMain(
  config: WorktreeConfig,
  sid: string,
  branch: string,
): Promise<SyncResult> {
  assertTaskBranch(branch);
  const cwd = worktreePath(config, sid);
  const fetched = await git(cwd, ['fetch', 'origin'], options(config));
  assertGitSuccess(fetched, 'fetch before syncing author branch');
  const checkout = await git(cwd, ['checkout', '-B', branch, `origin/${branch}`], options(config));
  assertGitSuccess(checkout, `checkout author branch ${branch} for sync`);
  const merged = await git(cwd, ['merge', '--no-edit', `origin/${config.mainBranch}`], options(config));
  if (merged.code === 0) return { hadConflicts: false, conflictedFiles: [] };

  const unmerged = await git(cwd, ['diff', '--name-only', '--diff-filter=U', '-z'], options(config));
  assertGitSuccess(unmerged, 'list files with merge conflicts');
  const conflictedFiles = unmerged.stdout.split('\0').filter(Boolean);
  if (conflictedFiles.length === 0) assertGitSuccess(merged, 'merge latest main branch');
  return { hadConflicts: true, conflictedFiles };
}

export async function finishSync(
  config: WorktreeConfig,
  sid: string,
  branch: string,
  conflictedFiles: readonly string[],
): Promise<string> {
  assertTaskBranch(branch);
  const cwd = worktreePath(config, sid);
  const staged = await git(cwd, ['add', '-A'], options(config));
  assertGitSuccess(staged, 'stage resolved merge');

  const unmerged = await git(cwd, ['diff', '--name-only', '--diff-filter=U', '-z'], options(config));
  assertGitSuccess(unmerged, 'verify merge conflict resolution');
  const stillUnmerged = unmerged.stdout.split('\0').filter(Boolean);
  if (stillUnmerged.length > 0) {
    throw new ConflictResolutionError(stillUnmerged, `Unresolved merge conflicts: ${stillUnmerged.join(', ')}`);
  }

  const markerFiles: string[] = [];
  for (const file of conflictedFiles) {
    if (await containsConflictMarker(cwd, file)) markerFiles.push(file);
  }
  if (markerFiles.length > 0) {
    throw new ConflictResolutionError(markerFiles, `Conflict markers remain in: ${markerFiles.join(', ')}`);
  }

  const mergeCheck = await git(cwd, ['diff', '--check'], options(config));
  if (mergeCheck.code !== 0) {
    throw new ConflictResolutionError([...conflictedFiles], `git diff --check failed: ${mergeCheck.stderr.trim()}`);
  }
  const stagedCheck = await git(cwd, ['diff', '--cached', '--check'], options(config));
  if (stagedCheck.code !== 0) {
    throw new ConflictResolutionError([...conflictedFiles], `git diff --cached --check failed: ${stagedCheck.stderr.trim()}`);
  }

  const mergeHead = await git(cwd, ['rev-parse', '--verify', 'MERGE_HEAD'], options(config));
  assertGitSuccess(mergeHead, 'verify merge is awaiting its resolution commit');
  const committed = await git(cwd, ['commit', '--no-edit'], commitOptions(config));
  assertGitSuccess(committed, 'commit resolved merge');
  const head = await git(cwd, ['rev-parse', 'HEAD'], options(config));
  assertGitSuccess(head, 'read resolved merge commit');
  const pushed = await git(cwd, ['push', 'origin', branch], options(config));
  assertGitSuccess(pushed, `push resolved author branch ${branch}`);
  return head.stdout.trim();
}

export async function releaseWorktree(config: WorktreeConfig, sid: string): Promise<void> {
  const cwd = worktreePath(config, sid);
  // Discard tracked edits first: an aborted author turn leaves them behind, and checkout would carry them over.
  const reset = await git(cwd, ['reset', '--hard'], options(config));
  assertGitSuccess(reset, 'reset released session worktree');
  const checkout = await git(cwd, ['checkout', '--detach', `origin/${config.mainBranch}`], options(config));
  assertGitSuccess(checkout, 'release session worktree');
  const cleaned = await git(cwd, ['clean', '-fd'], options(config));
  assertGitSuccess(cleaned, 'clean released session worktree');
}

export async function removeWorktree(config: WorktreeConfig, sid: string): Promise<void> {
  const repoPath = baseClonePath(config);
  const target = worktreePath(config, sid);
  if (!(await exists(target))) return;
  const removed = await git(repoPath, ['worktree', 'remove', '--force', target], options(config));
  assertGitSuccess(removed, `remove worktree for session ${sid}`);
}

function options(config: WorktreeConfig) {
  return { timeoutMs: config.gitTimeoutMs };
}

function commitOptions(config: WorktreeConfig) {
  return { ...options(config), identity: config.gitIdentity };
}

function assertSessionId(sid: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sid) || sid === '.' || sid === '..') {
    throw new Error(`Invalid session id for worktree path: ${sid}`);
  }
}

function assertTaskBranch(branch: string): void {
  if (!branch.startsWith('quorum/task-') || branch.length <= 'quorum/task-'.length) {
    throw new Error(`Node task branches must start with quorum/task-: ${branch}`);
  }
  if (branch.startsWith('-') || branch.includes('..') || branch.endsWith('/')) {
    throw new Error(`Invalid task branch: ${branch}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function containsConflictMarker(worktree: string, file: string): Promise<boolean> {
  if (isAbsolute(file)) throw new ConflictResolutionError([file], 'Conflict file path must be relative');
  const target = resolve(worktree, file);
  const rel = relative(resolve(worktree), target);
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new ConflictResolutionError([file], `Conflict file escapes the worktree: ${file}`);
  }

  if (!(await exists(target))) return false;
  const realRoot = await realpath(worktree);
  const realTarget = await realpath(target);
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${sep}`)) {
    throw new ConflictResolutionError([file], `Conflict file resolves outside the worktree: ${file}`);
  }
  const stat = await lstat(target);
  if (!stat.isFile()) throw new ConflictResolutionError([file], `Conflict path is not a regular file: ${file}`);

  const content = await readFile(target, 'utf8');
  return content.split(/\r?\n/).some((line) => /^(<<<<<<<|=======|>>>>>>>)/.test(line));
}
