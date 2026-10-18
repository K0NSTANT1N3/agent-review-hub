import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { git } from '../helpers/git.js';
import { GREET, createToyRemote, mainLog, readMain, remoteBranches, writeFiles } from '../helpers/toy-project.js';

const run = promisify(execFile);

// Runs even before the Leader/Node exist: proves the fixture the scenarios rely on.
describe('toy project fixture', () => {
  let dir: string;
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it('creates a bare remote whose test passes, and fails for the BROKEN variant', async () => {
    dir = await mkdtemp(join(tmpdir(), 'quorum-fixture-'));
    const bare = await createToyRemote(dir);
    expect(await remoteBranches(bare)).toEqual(['main']);
    expect(await mainLog(bare)).toHaveLength(1);
    expect(JSON.parse((await readMain(bare, 'quorum.json'))!)).toMatchObject({ testCommand: 'node test.js' });

    const clone = join(dir, 'clone');
    await git(dir, 'clone', bare, clone);
    await expect(run('node', ['test.js'], { cwd: clone })).resolves.toBeDefined();

    for (const variant of ['variantA', 'variantB', 'resolved', 'withDefault'] as const) {
      await writeFiles(clone, { 'src/greet.js': GREET[variant] });
      await expect(run('node', ['test.js'], { cwd: clone }), variant).resolves.toBeDefined();
    }
    await writeFiles(clone, { 'src/greet.js': GREET.BROKEN });
    await expect(run('node', ['test.js'], { cwd: clone })).rejects.toMatchObject({ code: 1 });
  });
});
