import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addAgent, addApiToken } from '../src/index.js';
import { resolvePrincipal } from '../src/core/api-tokens.js';
import { openDatabase } from '../src/db/repo.js';

const directories: string[] = [];
const originalArgv = process.argv;
afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('quorum-leader add-token', () => {
  it.each([undefined, 'requester', 'owner'])('supports scope %s and defaults to requester', async (scope) => {
    const dir = mkdtempSync(join(tmpdir(), 'quorum-cli-token-'));
    directories.push(dir);
    const dbPath = join(dir, 'leader.db');
    const config = join(dir, 'leader.json');
    writeFileSync(config, JSON.stringify({ dbPath, repo: { remoteUrl: 'file:///unused' } }));
    await addAgent(dbPath, { id: 'alice', owner: 'Alice' });
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    process.argv = [process.execPath, 'quorum-leader', 'add-token', '--config', config, '--id', 'alice', '--label', 'test', ...(scope === undefined ? [] : ['--scope', scope])];
    vi.resetModules();
    await import('../src/cli.js');
    await vi.waitFor(() => expect(output).toHaveBeenCalledOnce());
    const token = String(output.mock.calls[0]![0]).trim();
    const db = openDatabase(dbPath);
    try {
      expect(resolvePrincipal(db, token)).toMatchObject({ scope: scope ?? 'requester', agent: { id: 'alice' } });
      expect(db.apiTokens.all()[0]).toMatchObject({ scope: scope ?? 'requester', label: 'test' });
    } finally { db.close(); }
  });

  it('invalidates both scopes on agent rotation and refuses tokens for revoked agents', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'quorum-token-rotation-'));
    directories.push(dir);
    const dbPath = join(dir, 'leader.db');
    await addAgent(dbPath, { id: 'alice', owner: 'Alice' });
    const tokens = await Promise.all(['requester', 'owner'].map((scope) => addApiToken(dbPath, { agentId: 'alice', scope: scope as 'requester' | 'owner' })));
    await addAgent(dbPath, { id: 'alice', owner: 'Alice' });
    const db = openDatabase(dbPath);
    try {
      for (const { token } of tokens) expect(resolvePrincipal(db, token)).toBeNull();
      db.agents.update('alice', { revoked: 1 });
    } finally { db.close(); }
    await expect(addApiToken(dbPath, { agentId: 'alice', scope: 'owner' })).rejects.toThrow(/not found or revoked/);
  });
});
