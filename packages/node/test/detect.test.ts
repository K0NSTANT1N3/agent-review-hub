import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADAPTER_TYPES, type AdapterConfig } from '@quorum/protocol';
import { adapterTrust, detectAgents } from '../src/detect.js';

describe('agent detection', () => {
  let root: string;
  const mock: AdapterConfig = { type: 'mock', scriptPath: 'unused', contextWindow: 200000 };

  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'quorum-detect-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function binary(name: string, body: string): Promise<string> {
    const file = join(root, name);
    await writeFile(file, `#!${process.execPath}\nif (process.argv[2] !== '--version') process.exit(42);\n${body}\n`);
    await chmod(file, 0o755);
    return file;
  }

  it('finds PATH executables, parses versions from either stream, caches, and keeps paths local', async () => {
    const count = join(root, 'count');
    await binary('claude', `require('node:fs').appendFileSync(${JSON.stringify(count)}, 'x'); console.log('Claude Code v2.1.5');`);
    await binary('codex', "console.error('codex-cli 0.100.0-beta.2+abc');");
    await binary('pi', "console.log('pi 1.2.3');");
    await binary('omp', "console.log('18.1.21');");
    await binary('kilo', "console.log('kilo 3.4.5');");
    await binary('opencode', "console.log('1.1.0');");
    const options = { path: root };
    const detected = await detectAgents(mock, options);
    expect(detected).toEqual([
      { type: 'claude-code', version: '2.1.5', trust: 'enforced' },
      { type: 'codex', version: '0.100.0-beta.2+abc', trust: 'sandboxed' },
      { type: 'pi', version: '1.2.3', trust: 'low' },
      { type: 'omp', version: '18.1.21', trust: 'low' },
      { type: 'kilo', version: '3.4.5', trust: 'low' },
      { type: 'opencode', version: '1.1.0', trust: 'low' },
    ]);
    expect(await detectAgents(mock, options)).toEqual(detected);
    expect(await readFile(count, 'utf8')).toBe('x');
    expect(JSON.stringify(detected)).not.toContain(root);
    detected[0]!.version = 'mutated';
    expect((await detectAgents(mock, options))[0]!.version).toBe('2.1.5');
  });

  it('checks configured binaryPath with spaces even outside PATH', async () => {
    const binaryPath = await binary('custom codex', "console.log('custom 9.8.7');");
    expect(await detectAgents({ type: 'codex', binaryPath, contextWindow: 200000 }, { path: join(root, 'missing') }))
      .toEqual([{ type: 'codex', version: '9.8.7', trust: 'sandboxed' }]);
  });

  it('never throws on missing, non-executable, invalid, failed, noisy, or timed-out binaries', async () => {
    await writeFile(join(root, 'claude'), 'not executable');
    await binary('codex', 'setInterval(() => {}, 1000);');
    await binary('pi', "console.log('unversioned');");
    await binary('omp', 'process.exit(1);');
    await binary('kilo', "console.log('x'.repeat(20000));");
    expect(await detectAgents(mock, { path: root, timeoutMs: 200 })).toEqual([]);
    expect(await detectAgents(mock, { path: join(root, 'missing') })).toEqual([]);
  });

  it('assigns trust to every registered adapter type', () => {
    expect(ADAPTER_TYPES.map((type) => adapterTrust(type))).toEqual(['enforced', 'sandboxed', 'low', 'low', 'low', 'low', 'enforced']);
  });
});
