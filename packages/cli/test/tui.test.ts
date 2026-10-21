import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientError } from '../src/client.js';
import { EXIT, run, type Deps } from '../src/run.js';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'quorum-cli-tui-'));
  directories.push(directory);
  const path = join(directory, 'cli.json');
  writeFileSync(path, JSON.stringify({ url: 'https://file.test', token: 'file-token' }), { mode: 0o600 });
  const out = vi.fn();
  const err = vi.fn();
  const startTui = vi.fn<NonNullable<Deps['startTui']>>().mockResolvedValue();
  const deps: Deps = { env: { QUORUM_CONFIG: path }, out, err, startTui, readStdin: async () => '', stdinIsTTY: true, fetch: vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ agents: [] }))) };
  return { deps, out, err, startTui };
}

describe('quorum tui', () => {
  it('launches with the saved login and waits for terminal cleanup', async () => {
    const { deps, startTui } = setup();
    let finish!: () => void;
    startTui.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const result = run(['tui'], deps);
    await vi.waitFor(() => expect(startTui).toHaveBeenCalled());
    expect(startTui).toHaveBeenCalledWith({ url: 'https://file.test', token: 'file-token', warning: undefined });
    finish();
    expect(await result).toBe(EXIT.OK);
  });

  it('applies flags > environment > file, including CLI ws(s) URL normalization', async () => {
    const { deps, startTui } = setup();
    deps.env.QUORUM_URL = 'wss://env.test/ws/node';
    deps.env.QUORUM_TOKEN = 'env-token';
    await run(['tui'], deps);
    expect(startTui).toHaveBeenLastCalledWith(expect.objectContaining({ url: 'https://env.test', token: 'env-token' }));
    await run(['tui', '--url', 'http://flag.test/path', '--token', 'flag-token'], deps);
    expect(startTui).toHaveBeenLastCalledWith(expect.objectContaining({ url: 'http://flag.test', token: 'flag-token' }));
  });

  it.each([['tui', '--help'], ['tui', '-h'], ['--help'], ['--version']])('shows %j without login, TTY or UI launch', async (...argv) => {
    const { deps, out, startTui } = setup();
    deps.env = { QUORUM_CONFIG: '/missing/config.json' };
    deps.stdinIsTTY = false;
    expect(await run(argv, deps)).toBe(EXIT.OK);
    expect(out).toHaveBeenCalled();
    expect(startTui).not.toHaveBeenCalled();
  });

  it.each([['--bogus'], ['--url'], ['extra'], ['--json']])('rejects invalid TUI arguments %j with exit 2', async (...args) => {
    const { deps, startTui } = setup();
    expect(await run(['tui', ...args], deps)).toBe(EXIT.USAGE);
    expect(startTui).not.toHaveBeenCalled();
  });

  it('checks terminal, network and remote authentication before opening the UI', async () => {
    const { deps, startTui } = setup();
    deps.stdoutIsTTY = false;
    expect(await run(['tui'], deps)).toBe(EXIT.ERROR);
    deps.stdoutIsTTY = true;
    deps.fetch = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    expect(await run(['tui'], deps)).toBe(EXIT.ERROR);
    deps.fetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: 'FORBIDDEN', message: 'revoked' }), { status: 403 }));
    expect(await run(['tui'], deps)).toBe(EXIT.AUTH);
    expect(startTui).not.toHaveBeenCalled();
  });

  it('uses auth exit 6 for missing config and error exit 1 for terminal failure', async () => {
    const { deps, err, startTui } = setup();
    deps.env = { QUORUM_CONFIG: '/missing/config.json' };
    expect(await run(['tui'], deps)).toBe(EXIT.AUTH);
    expect(startTui).not.toHaveBeenCalled();
    deps.env.QUORUM_URL = 'https://leader.test';
    deps.env.QUORUM_TOKEN = 'secret';
    startTui.mockRejectedValueOnce(new Error('quorum tui needs an interactive terminal.'));
    expect(await run(['tui'], deps)).toBe(EXIT.ERROR);
    expect(err).toHaveBeenLastCalledWith('quorum: quorum tui needs an interactive terminal.');
    startTui.mockRejectedValueOnce(new ClientError(403, 'FORBIDDEN', 'Denied'));
    expect(await run(['tui'], deps)).toBe(EXIT.AUTH);
  });
});
