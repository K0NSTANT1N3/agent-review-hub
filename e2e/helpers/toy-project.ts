import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { git } from './git.js';

// A tiny repository whose `quorum.json` test command is `node test.js`.
// test.js passes iff greet('x') === GREETING_PREFIX + 'x'.

export const GREETING_PREFIX = 'Hello ';

export const TOY_FILES: Record<string, string> = {
  'quorum.json': JSON.stringify({ testCommand: 'node test.js', testTimeoutSec: 60 }, null, 2) + '\n',
  'package.json': JSON.stringify({ name: 'toy', private: true, type: 'module' }, null, 2) + '\n',
  'src/greet.js': "export const greet = (name) => `Hello ${name}`;\n",
  'test.js': [
    "import { greet } from './src/greet.js';",
    "const got = greet('x');",
    "if (got !== 'Hello x') {",
    '  console.error(`expected "Hello x", got "${got}"`);',
    '  process.exit(1);',
    '}',
    "console.log('ok');",
    '',
  ].join('\n'),
};

/** greet.js variants. All PASS tests unless named BROKEN. */
export const GREET = {
  /** Same behaviour, different line — use two of these to force a merge conflict. */
  variantA: "export const greet = (name) => 'Hello ' + name; // variant A\n",
  variantB: "export const greet = (name) => ['Hello', name].join(' '); // variant B\n",
  resolved: "export const greet = (name) => `Hello ${name}`; // resolved\n",
  withDefault: "export const greet = (name = 'world') => `Hello ${name}`;\n",
  BROKEN: "export const greet = (name) => `Bye ${name}`;\n",
};

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
}

/** Creates `<dir>/remote.git` (bare, branch main) seeded with TOY_FILES. Returns the bare path. */
export async function createToyRemote(dir: string): Promise<string> {
  const bare = join(dir, 'remote.git');
  const seed = join(dir, 'seed');
  await mkdir(bare, { recursive: true });
  await mkdir(seed, { recursive: true });
  await git(bare, 'init', '--bare', '-b', 'main');
  await git(seed, 'init', '-b', 'main');
  await writeFiles(seed, TOY_FILES);
  await git(seed, 'add', '-A');
  await git(seed, 'commit', '-m', 'toy project');
  await git(seed, 'remote', 'add', 'origin', bare);
  await git(seed, 'push', '-u', 'origin', 'main');
  return bare;
}

/** Content of `path` on the remote's main branch, or null. */
export async function readMain(bare: string, path: string, branch = 'main'): Promise<string | null> {
  try {
    return (await git(bare, 'show', `${branch}:${path}`)) + '\n';
  } catch {
    return null;
  }
}

export async function remoteBranches(bare: string): Promise<string[]> {
  const out = await git(bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads');
  return out === '' ? [] : out.split('\n');
}

export async function mainLog(bare: string): Promise<{ sha: string; message: string }[]> {
  const out = await git(bare, 'log', 'main', '--format=%H%x1f%B%x1e');
  return out
    .split('\x1e')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [sha = '', message = ''] = entry.split('\x1f');
      return { sha, message: message.trim() };
    });
}
