import { readFile, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertGitSuccess, git } from '../../src/git/git.js';
import {
  commitAndPushAfterAuthorTurn,
  createWorktree,
  diffInfo,
  ensureBaseClone,
  ensureCleanBeforeAuthorTurn,
  finishSync,
  prepareAuthorExistingBranch,
  prepareAuthorNewBranch,
  prepareReviewer,
  releaseWorktree,
  removeWorktree,
  resetIfReviewerModified,
  syncWithMain,
  worktreePath,
} from '../../src/git/worktrees.js';
import { createTempRepo, type TempRepo } from '../helpers/temp-repo.js';

describe('git helper and worktree operations', { timeout: 20_000 }, () => {
  let fixture: TempRepo;

  beforeEach(async () => {
    fixture = await createTempRepo();
  });

  afterEach(async () => {
    await fixture.dispose();
  });

  it('returns exit status and injects the configured identity for commits', async () => {
    const cwd = fixture.seedPath;
    await writeFile(join(cwd, 'identity.txt'), 'committed\n');
    const added = await git(cwd, ['add', 'identity.txt']);
    expect(added.code).toBe(0);

    const commit = await git(cwd, ['commit', '-m', 'identity check'], {
      identity: { name: 'Injected Name', email: 'injected@example.invalid' },
    });
    expect(commit.code).toBe(0);
    const author = await git(cwd, ['log', '-1', '--format=%an <%ae>']);
    expect(author.stdout.trim()).toBe('Injected Name <injected@example.invalid>');

    const failed = await git(cwd, ['not-a-git-command']);
    expect(failed.code).not.toBe(0);
  });

  it('runs concurrent fetches from worktrees of one clone without ref lock races', async () => {
    const { config } = fixture;
    await ensureBaseClone(config);
    const worktrees = await Promise.all(['s1', 's2', 's3'].map((sid) => createWorktree(config, sid)));
    for (let round = 0; round < 5; round += 1) {
      await writeFile(join(fixture.seedPath, 'README.md'), `round ${round}\n`);
      assertGitSuccess(await git(fixture.seedPath, ['commit', '-am', `round ${round}`]), 'commit round');
      const refs = ['main', ...Array.from({ length: 10 }, (_, i) => `HEAD:refs/heads/quorum/task-${i}`)];
      assertGitSuccess(await git(fixture.seedPath, ['push', '--force', 'origin', ...refs]), 'push round');
      const fetched = await Promise.all(worktrees.map((cwd) => git(cwd, ['fetch', 'origin', '--prune'])));
      for (const result of fetched) expect(result.stderr).not.toContain('cannot lock ref');
      for (const result of fetched) expect(result.code).toBe(0);
    }
  });

  it('creates the fixed session worktree and prepares new and existing task branches', async () => {
    const { config } = fixture;
    const fetchedClone = await ensureBaseClone(config);
    expect(fetchedClone).toBe(join(config.workspaceDir, 'repo'));

    const sid = 'session-1';
    const cwd = await createWorktree(config, sid);
    expect(cwd).toBe(worktreePath(config, sid));
    expect(resolve(cwd)).toBe(resolve(join(config.workspaceDir, 'worktrees', sid)));
    expect(await createWorktree(config, sid)).toBe(cwd);

    const branch = 'quorum/task-41';
    const base = await prepareAuthorNewBranch(config, sid, branch);
    expect(base).toMatch(/^[0-9a-f]{40,64}$/);
    const remoteBranch = await git(config.workspaceDir, [
      '--git-dir', fixture.remotePath, 'rev-parse', `refs/heads/${branch}`,
    ]);
    expect(remoteBranch.code).toBe(0);

    const resumedBase = await prepareAuthorExistingBranch(config, sid, branch);
    expect(resumedBase).toBe(base);
  });

  it('recovers dirty files, commits author turns, pushes, and calculates the full diff', async () => {
    const { config, remotePath } = fixture;
    const sid = 'author-session';
    const cwd = await createWorktree(config, sid);
    const branch = 'quorum/task-42';
    const base = await prepareAuthorNewBranch(config, sid, branch);

    await writeFile(join(cwd, 'recovered.txt'), 'recovered\n');
    await ensureCleanBeforeAuthorTurn(config, sid);
    const recoveredCommit = await git(cwd, ['log', '-1', '--format=%s']);
    expect(recoveredCommit.stdout.trim()).toBe('quorum: recovered uncommitted changes');

    expect(await commitAndPushAfterAuthorTurn(config, sid, branch, 42, 1)).toBeNull();
    await writeFile(join(cwd, 'feature.txt'), 'one\ntwo\n');
    const commit = await commitAndPushAfterAuthorTurn(config, sid, branch, 42, 2);
    expect(commit).toMatch(/^[0-9a-f]{40,64}$/);

    const info = await diffInfo(config, sid, base);
    expect(info.filesChanged.sort()).toEqual(['feature.txt', 'recovered.txt']);
    expect(info.diffLines).toBe(3);

    const pushed = await git(config.workspaceDir, ['--git-dir', remotePath, 'rev-parse', `refs/heads/${branch}`]);
    expect(pushed.stdout.trim()).toBe(commit);
  });

  it('release discards tracked edits left by an aborted author turn', async () => {
    const { config } = fixture;
    const sid = 'cancelled-session';
    const cwd = await createWorktree(config, sid);
    await prepareAuthorNewBranch(config, sid, 'quorum/task-44');
    await writeFile(join(cwd, 'README.md'), 'half-written edit from a cancelled turn\n');
    await writeFile(join(cwd, 'scratch.txt'), 'untracked\n');
    await releaseWorktree(config, sid);
    const status = await git(cwd, ['status', '--porcelain']);
    expect(status.stdout.trim()).toBe('');
  });

  it('checks out a reviewer commit and resets reviewer-created changes', async () => {
    const { config } = fixture;
    const sid = 'review-session';
    const cwd = await createWorktree(config, sid);
    await prepareAuthorNewBranch(config, sid, 'quorum/task-43');
    await writeFile(join(cwd, 'author.txt'), 'author change\n');
    const head = await commitAndPushAfterAuthorTurn(config, sid, 'quorum/task-43', 43, 1);
    expect(head).not.toBeNull();

    await prepareReviewer(config, sid, head as string);
    const checkedOut = await git(cwd, ['rev-parse', 'HEAD']);
    expect(checkedOut.stdout.trim()).toBe(head);

    await writeFile(join(cwd, 'author.txt'), 'reviewer modified tracked file\n');
    await writeFile(join(cwd, 'reviewer-created.txt'), 'untracked\n');
    expect(await resetIfReviewerModified(config, sid)).toBe(true);
    expect(await readFile(join(cwd, 'author.txt'), 'utf8')).toBe('author change\n');
    await expect(access(join(cwd, 'reviewer-created.txt'))).rejects.toThrow();
    expect(await resetIfReviewerModified(config, sid)).toBe(false);
  });

  it('detects and finishes a real merge conflict, checking markers before pushing', async () => {
    const { config, seedPath, remotePath } = fixture;
    const sid = 'sync-session';
    const cwd = await createWorktree(config, sid);
    const branch = 'quorum/task-44';
    await prepareAuthorNewBranch(config, sid, branch);
    await writeFile(join(cwd, 'README.md'), 'author side\n');
    await commitAndPushAfterAuthorTurn(config, sid, branch, 44, 1);

    await writeFile(join(seedPath, 'README.md'), 'main side\n');
    const seedStage = await git(seedPath, ['add', 'README.md']);
    expect(seedStage.code).toBe(0);
    const seedCommit = await git(seedPath, ['commit', '-m', 'advance main']);
    expect(seedCommit.code).toBe(0);
    const seedPush = await git(seedPath, ['push', 'origin', 'main']);
    expect(seedPush.code).toBe(0);

    const conflict = await syncWithMain(config, sid, branch);
    expect(conflict.hadConflicts).toBe(true);
    expect(conflict.conflictedFiles).toEqual(['README.md']);
    await expect(finishSync(config, sid, branch, conflict.conflictedFiles)).rejects.toThrow(/markers remain/i);

    await writeFile(join(cwd, 'README.md'), 'both sides retained\n');
    const mergeCommit = await finishSync(config, sid, branch, conflict.conflictedFiles);
    const pushed = await git(config.workspaceDir, ['--git-dir', remotePath, 'rev-parse', `refs/heads/${branch}`]);
    expect(pushed.stdout.trim()).toBe(mergeCommit);
    const mergeParents = await git(cwd, ['rev-list', '--parents', '-n', '1', 'HEAD']);
    expect(mergeParents.stdout.trim().split(' ')).toHaveLength(3);
  });

  it('reports a clean sync, releases a session and removes the worktree', async () => {
    const { config } = fixture;
    const sid = 'release-session';
    const cwd = await createWorktree(config, sid);
    await prepareAuthorNewBranch(config, sid, 'quorum/task-45');
    const sync = await syncWithMain(config, sid, 'quorum/task-45');
    expect(sync).toEqual({ hadConflicts: false, conflictedFiles: [] });

    await releaseWorktree(config, sid);
    const status = await git(cwd, ['status', '--porcelain']);
    expect(status.stdout).toBe('');
    const branch = await git(cwd, ['branch', '--show-current']);
    expect(branch.stdout.trim()).toBe('');

    await removeWorktree(config, sid);
    await expect(access(cwd)).rejects.toThrow();
    await removeWorktree(config, sid);
  });

  it('clones the base repository if it is missing and rejects unsafe session ids', async () => {
    const { config } = fixture;
    const cloneConfig = { ...config, workspaceDir: join(fixture.root, 'fresh-workspace') };
    expect(await ensureBaseClone(cloneConfig)).toBe(join(cloneConfig.workspaceDir, 'repo'));
    await expect(createWorktree(cloneConfig, '../escape')).rejects.toThrow(/invalid session id/i);
  });
});
