import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientError, loadTranscript, OWNER_TOKEN_HELP, QuorumClient } from '../src/api-client.js';
import { configPath, normalizeLeaderUrl, parseFlags, readConfig, resolveConfig } from '../src/config.js';
import { taskView } from './fixtures.js';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function configFile(mode = 0o600, text = JSON.stringify({ url: 'http://file.test', token: 'file-token' })): string {
  const directory = mkdtempSync(join(tmpdir(), 'quorum-tui-'));
  directories.push(directory);
  const path = join(directory, 'cli.json');
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
  return path;
}

describe('CLI config', () => {
  it('uses CLI-compatible paths and flags > environment > file precedence', () => {
    const path = configFile();
    expect(configPath({ QUORUM_CONFIG: path, XDG_CONFIG_HOME: '/ignored' })).toBe(path);
    expect(configPath({ XDG_CONFIG_HOME: '/xdg' })).toBe('/xdg/quorum/cli.json');
    expect(configPath({})).toMatch(/\.config\/quorum\/cli.json$/);
    expect(resolveConfig({}, { QUORUM_CONFIG: path })).toMatchObject({ url: 'http://file.test', token: 'file-token' });
    expect(resolveConfig({ url: 'https://flag.test' }, { QUORUM_CONFIG: path, QUORUM_URL: 'http://env.test', QUORUM_TOKEN: 'env-token' })).toMatchObject({ url: 'https://flag.test', token: 'env-token' });
    expect(resolveConfig({ token: 'flag-token' }, { QUORUM_CONFIG: path, QUORUM_TOKEN: 'env-token' }).token).toBe('flag-token');
  });

  it.each([0o640, 0o604, 0o644])('warns when token file is group/world readable (%s)', (mode) => {
    const path = configFile(mode);
    const result = readConfig(path);
    expect(result.config.token).toBe('file-token');
    expect(result.warning).toContain('group/world readable');
    expect(result.warning).toContain('chmod 600');
    expect(result.warning).not.toContain('file-token');
  });

  it('accepts private files and handles missing, malformed and untyped config', () => {
    expect(readConfig(configFile()).warning).toBeUndefined();
    expect(readConfig(configFile(0o644), 'win32').warning).toBeUndefined();
    expect(readConfig('/does-not-exist/quorum-cli.json')).toEqual({ config: {} });
    expect(readConfig(configFile(0o600, '{oops'))).toEqual({ config: {} });
    expect(readConfig(configFile(0o600, '{"url":42,"token":null}')).config).toEqual({});
    expect(readConfig(configFile(0o600, 'null')).config).toEqual({});
  });

  it('parses flags and rejects unsupported URLs, credentials and unknown options', () => {
    expect(parseFlags(['--url', 'https://leader.test', '--token', 'secret'])).toEqual({ url: 'https://leader.test', token: 'secret' });
    expect(parseFlags(['-h']).help).toBe(true);
    expect(() => parseFlags(['--unknown'])).toThrow();
    expect(() => parseFlags(['--token'])).toThrow();
    expect(normalizeLeaderUrl(' https://leader.test/path ')).toBe('https://leader.test');
    // The same join URLs the quorum CLI and the desktop app accept.
    expect(normalizeLeaderUrl('ws://leader.test:7420/ws/node')).toBe('http://leader.test:7420');
    expect(normalizeLeaderUrl('wss://leader.test/ws/node')).toBe('https://leader.test');
    expect(() => normalizeLeaderUrl('ftp://leader.test')).toThrow('http');
    expect(() => normalizeLeaderUrl('http://user:pass@leader.test')).toThrow('credentials');
  });
});

function clientResponding(status: number, body: unknown) {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
  return { client: new QuorumClient('https://leader.test', 'secret-token', fetchImpl), fetchImpl };
}

describe('REST client', () => {
  it('uses protocol methods, body and bearer auth', async () => {
    const { client, fetchImpl } = clientResponding(200, taskView());
    await client.call('sendBackTask', { id: 12, body: { comment: 'Fix TTL' } });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://leader.test/api/tasks/12/send-back');
    expect(init).toMatchObject({ method: 'POST', headers: { authorization: 'Bearer secret-token', 'content-type': 'application/json' }, body: '{"comment":"Fix TTL"}' });
  });

  it('encodes IDs/query cursors and validates REST responses', async () => {
    const { client, fetchImpl } = clientResponding(200, { sessions: [] });
    expect(await client.call('getTaskTranscript', { id: 'a/b', query: { sid: 's&1', afterSeq: '9' } })).toEqual({ sessions: [] });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe('https://leader.test/api/tasks/a%2Fb/transcript?sid=s%261&afterSeq=9');
    expect(fetchImpl.mock.calls[0]?.[1]?.body).toBeUndefined();
    await expect(clientResponding(200, {}).client.call('getTask')).rejects.toThrow();
  });

  it.each(['approveTask', 'sendBackTask', 'pauseTask', 'resumeTask', 'cancelTask'] as const)('explains owner token requirements on %s 403', async (route) => {
    await expect(clientResponding(403, { error: 'FORBIDDEN', message: 'requester token' }).client.call(route, { id: 12 })).rejects.toThrow(OWNER_TOKEN_HELP);
  });

  it('keeps ordinary HTTP/network errors visible and aborts pending requests on close', async () => {
    await expect(clientResponding(409, { error: 'CONFLICT', message: 'Task is locked' }).client.call('answerTask', { id: 12 })).rejects.toThrow('HTTP 409: Task is locked');
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('network secret-token'));
    await expect(new QuorumClient('http://leader.test', 'secret-token', fetchImpl).call('listTasks')).rejects.toThrow('Cannot reach the Leader at http://leader.test');
    const response = clientResponding(200, { tasks: [] });
    await response.client.call('listTasks');
    const signal = response.fetchImpl.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    response.client.close();
    expect(signal?.aborted).toBe(true);
  });
});

describe('transcript compatibility', () => {
  it.each([[404, { message: 'not found' }], [500, { message: 'not implemented' }], [500, 'Not implemented yet']] as const)('falls back for unsupported route %s', async (status, body) => {
    expect(await loadTranscript(clientResponding(status, body).client, 12)).toEqual({ supported: false, sessions: [] });
  });

  it('does not hide server failures or auth failures as unsupported transcripts', async () => {
    await expect(loadTranscript(clientResponding(500, { message: 'database error' }).client, 12)).rejects.toBeInstanceOf(ClientError);
    await expect(loadTranscript(clientResponding(403, { message: 'forbidden' }).client, 12)).rejects.toThrow('HTTP 403');
    expect(await loadTranscript(clientResponding(200, { sessions: [] }).client, 12)).toEqual({ supported: true, sessions: [] });
  });
});
