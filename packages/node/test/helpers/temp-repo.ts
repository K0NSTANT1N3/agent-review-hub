import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertGitSuccess, git } from '../../src/git/git.js';
import type { WorktreeConfig } from '../../src/git/worktrees.js';

export interface TempRepo {
  root: string;
  remotePath: string;
  seedPath: string;
  config: WorktreeConfig;
  dispose(): Promise<void>;
}

export async function createTempRepo(options: { cloneBase?: boolean } = {}): Promise<TempRepo> {
  const root = await mkdtemp(join(tmpdir(), 'quorum-node-git-'));
  const remotePath = join(root, 'remote.git');
  const seedPath = join(root, 'seed');
  const workspaceDir = join(root, 'workspace');
  const identity = { name: 'Quorum Test', email: 'quorum-test@example.invalid' };

  try {
    const bare = await git(root, ['init', '--bare', '--initial-branch=main', remotePath]);
    assertGitSuccess(bare, 'initialize temporary bare remote');
    await mkdir(seedPath, { recursive: true });
    const initialized = await git(seedPath, ['init', '--initial-branch=main']);
    assertGitSuccess(initialized, 'initialize temporary seed repository');
    const configuredName = await git(seedPath, ['config', 'user.name', identity.name]);
    assertGitSuccess(configuredName, 'configure temporary git author');
    const configuredEmail = await git(seedPath, ['config', 'user.email', identity.email]);
    assertGitSuccess(configuredEmail, 'configure temporary git email');
    await writeFile(join(seedPath, 'README.md'), 'initial\n');
    const staged = await git(seedPath, ['add', 'README.md']);
    assertGitSuccess(staged, 'stage initial fixture file');
    const initialCommit = await git(seedPath, ['commit', '-m', 'initial']);
    assertGitSuccess(initialCommit, 'commit initial fixture file');
    const remoteAdded = await git(seedPath, ['remote', 'add', 'origin', remotePath]);
    assertGitSuccess(remoteAdded, 'configure temporary bare remote');
    const pushed = await git(seedPath, ['push', '-u', 'origin', 'main']);
    assertGitSuccess(pushed, 'push initial fixture branch');

    if (options.cloneBase !== false) {
      await mkdir(workspaceDir, { recursive: true });
      const cloned = await git(workspaceDir, ['clone', remotePath, join(workspaceDir, 'repo')]);
      assertGitSuccess(cloned, 'clone fixture base repository');
    }

    const config: WorktreeConfig = {
      workspaceDir,
      repoRemoteUrl: remotePath,
      mainBranch: 'main',
      gitIdentity: identity,
    };
    return {
      root,
      remotePath,
      seedPath,
      config,
      dispose: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
