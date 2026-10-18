import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { git } from '../../src/git/git.js';
import { createWorktree } from '../../src/git/worktrees.js';
import { readProjectConfig } from '../../src/runner/project-config.js';
import { runSetupIfNeeded, runTests } from '../../src/runner/tests.js';
import { createTempRepo, type TempRepo } from '../helpers/temp-repo.js';

describe('project config and command runner', () => {
  let fixture: TempRepo;

  beforeEach(async () => {
    fixture = await createTempRepo();
  });

  afterEach(async () => {
    await fixture.dispose();
  });

  it('defaults safely when main has no quorum.json', async () => {
    const cwd = await createWorktree(fixture.config, 'missing-config');
    await expect(readProjectConfig(cwd)).resolves.toEqual({
      setupCommand: null,
      testCommand: null,
      testTimeoutSec: 900,
    });
    await expect(runTests(cwd)).resolves.toEqual({
      passed: true,
      exitCode: null,
      outputTail: 'no testCommand configured',
      durationMs: 0,
      timedOut: false,
    });
  });

  it('runs a passing test command from main and captures output', async () => {
    const cwd = await worktreeWithMainConfig({
      testCommand: 'node -e "console.log(\'tests passed\')"',
      testTimeoutSec: 5,
    });
    const result = await runTests(cwd);
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.outputTail).toContain('tests passed');
  });

  it('reports a failing command and its exit code', async () => {
    const cwd = await worktreeWithMainConfig({
      testCommand: 'node -e "console.log(\'failure marker\'); process.exit(7)"',
      testTimeoutSec: 5,
    });
    const result = await runTests(cwd);
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(7);
    expect(result.outputTail).toContain('failure marker');
  });

  it('kills a command tree when the main-branch timeout expires', async () => {
    const cwd = await worktreeWithMainConfig({
      testCommand: 'node -e "setTimeout(() => {}, 10000)"',
      testTimeoutSec: 1,
    });
    const result = await runTests(cwd);
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(5000);
  });

  it('runs setup once, then reruns it only after a lockfile hash changes', async () => {
    const cwd = await worktreeWithMainFiles({
      'quorum.json': JSON.stringify({ setupCommand: 'node setup.cjs', testTimeoutSec: 5 }),
      'setup.cjs': [
        "const fs = require('node:fs');",
        "const file = 'setup-count';",
        'const count = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0;',
        'fs.writeFileSync(file, String(count + 1));',
      ].join('\n'),
      'package-lock.json': '{"lock":1}\n',
    }, 'setup-session');

    expect(await runSetupIfNeeded(cwd)).toMatchObject({ ran: true });
    expect(await readFile(join(cwd, 'setup-count'), 'utf8')).toBe('1');
    expect(await runSetupIfNeeded(cwd)).toMatchObject({ ran: false });

    await writeFile(join(cwd, 'package-lock.json'), '{"lock":2}\n');
    expect(await runSetupIfNeeded(cwd)).toMatchObject({ ran: true });
    expect(await readFile(join(cwd, 'setup-count'), 'utf8')).toBe('2');
    const status = await git(cwd, ['status', '--porcelain']);
    expect(status.stdout).not.toContain('setup-lockfiles');
  });

  it('ignores a quorum.json change that exists only on a task branch', async () => {
    const cwd = await worktreeWithMainConfig({
      testCommand: 'node -e "process.stdout.write(\'main config\')"',
      testTimeoutSec: 5,
    }, 'branch-config');
    const branch = await git(cwd, ['checkout', '-b', 'quorum/task-61']);
    expect(branch.code).toBe(0);
    await writeFile(join(cwd, 'quorum.json'), JSON.stringify({
      testCommand: 'node -e "process.exit(9)"',
      testTimeoutSec: 5,
    }));
    const staged = await git(cwd, ['add', 'quorum.json']);
    expect(staged.code).toBe(0);
    const committed = await git(cwd, ['commit', '-m', 'change task branch test command'], {
      identity: fixture.config.gitIdentity,
    });
    expect(committed.code).toBe(0);

    const config = await readProjectConfig(cwd);
    expect(config.testCommand).toContain('main config');
    expect((await runTests(cwd)).passed).toBe(true);
  });

  it('retains only the bounded output tail', async () => {
    const cwd = await worktreeWithMainConfig({
      testCommand: 'node -e "for (let i = 0; i < 250; i++) console.log(String(i).padEnd(100, \'x\'))"',
      testTimeoutSec: 5,
    }, 'output-tail');
    const result = await runTests(cwd);
    expect(result.passed).toBe(true);
    expect(Buffer.byteLength(result.outputTail, 'utf8')).toBeLessThanOrEqual(20 * 1024);
    expect(result.outputTail).toContain('249');
    expect(result.outputTail.startsWith('0')).toBe(false);
  });

  async function worktreeWithMainConfig(config: Record<string, unknown>, sid = 'test-session'): Promise<string> {
    return worktreeWithMainFiles({ 'quorum.json': JSON.stringify(config) }, sid);
  }

  async function worktreeWithMainFiles(files: Record<string, string>, sid: string): Promise<string> {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(fixture.seedPath, name), content);
    }
    const staged = await git(fixture.seedPath, ['add', '-A']);
    expect(staged.code).toBe(0);
    const commit = await git(fixture.seedPath, ['commit', '-m', 'configure main project'], {
      identity: fixture.config.gitIdentity,
    });
    expect(commit.code).toBe(0);
    const pushed = await git(fixture.seedPath, ['push', 'origin', 'main']);
    expect(pushed.code).toBe(0);
    const fetched = await git(join(fixture.config.workspaceDir, 'repo'), ['fetch', 'origin', '--prune']);
    expect(fetched.code).toBe(0);
    return createWorktree(fixture.config, sid);
  }
});
