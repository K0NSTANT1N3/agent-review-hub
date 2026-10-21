import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNodeConfig, ownerSettingsFromNodeConfig, type NodeConfig, type OwnerSettings } from '@quorum/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { LeaderClient } from '../../src/ws/leader-client.js';
import { openJournal, type NodeJournal } from '../../src/journal.js';
import { FakeLeader, welcomeFrame } from '../helpers/fake-leader.js';

const leaders: FakeLeader[] = [];
const clients: LeaderClient[] = [];
const journals: NodeJournal[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(clients.splice(0).map((client) => client.stop()));
  await Promise.all(leaders.splice(0).map((leader) => leader.stop()));
  for (const journal of journals.splice(0)) journal.close();
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('LeaderClient', () => {
  it('sends hello and periodic heartbeats with live settings and session reports', async () => {
    const fixture = await createFixture();
    const session = fixture.journal.createSession({
      sid: 'sid-open', nativeId: 'native-1', worktree: '/tmp/worktree', profile: 'author',
      contextTokens: 1234, state: 'busy',
    });
    expect(session.sid).toBe('sid-open');
    let settings: OwnerSettings = ownerSettingsFromNodeConfig(fixture.config);
    const client = createClient(fixture, {
      getSettings: () => settings,
      idleSeconds: () => 42,
      getRateLimitedUntil: () => 5000,
      detectedAgents: [{ type: 'codex', version: '1.2.3', trust: 'sandboxed' }],
    });
    client.start();
    const connection = await fixture.leader.waitForConnection();
    const hello = await connection.next('hello');
    expect(hello).toMatchObject({
      agentId: 'agent-1', token: 'secret', protocolVersion: expect.any(Number),
      settings: ownerSettingsFromNodeConfig(fixture.config), adapterType: 'mock',
      sessions: [{ sid: 'sid-open', alive: true, busy: true, contextTokens: 1234 }],
      trust: 'enforced', detectedAgents: [{ type: 'codex', version: '1.2.3', trust: 'sandboxed' }],
    });

    connection.send(welcomeFrame({ heartbeatIntervalSec: 1 }));
    const firstHeartbeat = await connection.next('heartbeat');
    expect(firstHeartbeat.status).toMatchObject({
      settings,
      humanIdleSec: 42,
      rateLimitedUntil: 5000,
      sessions: [{ sid: 'sid-open', alive: true, busy: true, contextTokens: 1234 }],
      trust: 'enforced', detectedAgents: [{ type: 'codex', version: '1.2.3', trust: 'sandboxed' }],
    });

    settings = { ...settings, paused: true };
    const nextHeartbeat = await connection.next('heartbeat', (frame) => frame.status.settings.paused, 2500);
    expect(nextHeartbeat.status.settings.paused).toBe(true);
  });

  it('journals and acks a command before dispatch, then only re-acks duplicates', async () => {
    const fixture = await createFixture();
    const onCommand = vi.fn((msgId: string) => {
      expect(fixture.journal.isProcessed(msgId)).toBe(true);
    });
    const client = createClient(fixture, { onCommand });
    client.start();
    const connection = await fixture.leader.waitForConnection();
    await connection.next('hello');
    connection.send(welcomeFrame());
    await connection.next('heartbeat');

    const cmd = { kind: 'cmd' as const, msgId: 'command-1', cmd: { type: 'session.open' as const, sid: 'sid-1', profile: 'author' as const } };
    connection.send(cmd);
    await expect(connection.next('ack', (frame) => frame.msgId === 'command-1')).resolves.toMatchObject({ msgId: 'command-1' });
    expect(onCommand).toHaveBeenCalledTimes(1);

    connection.send(cmd);
    await expect(connection.next('ack', (frame) => frame.msgId === 'command-1')).resolves.toMatchObject({ msgId: 'command-1' });
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(fixture.journal.getCommand('command-1')?.cmd).toEqual(cmd.cmd);
  });

  it('reconnects after Leader restart and resends the same unacked event', async () => {
    const fixture = await createFixture();
    const client = createClient(fixture, { random: () => 0.5 });
    client.start();
    const first = await fixture.leader.waitForConnection();
    await first.next('hello');
    first.send(welcomeFrame({ resendUnackedSec: 1 }));
    await first.next('heartbeat');

    const msgId = client.enqueueEvent({ type: 'session.opened', inReplyTo: 'command-open', sid: 'sid-1', ok: true });
    await expect(first.next('evt', (frame) => frame.msgId === msgId)).resolves.toMatchObject({ msgId });
    await expect(first.next('evt', (frame) => frame.msgId === msgId, 2500)).resolves.toMatchObject({ msgId });

    await fixture.leader.restart();
    const second = await fixture.leader.waitForConnection(2, 5000);
    await second.next('hello');
    second.send(welcomeFrame());
    await second.next('heartbeat');
    await expect(second.next('evt', (frame) => frame.msgId === msgId)).resolves.toMatchObject({ msgId });

    second.send({ kind: 'ack', msgId });
    await waitFor(() => fixture.journal.unackedEvents().length === 0);
    expect(fixture.journal.unackedEvents()).toEqual([]);
  });

  it('treats a 1008 close before welcome as terminal and names the adapter', async () => {
    const fixture = await createFixture();
    fixture.config.adapter = { type: 'codex', contextWindow: 200000 };
    const errors: Error[] = [];
    const client = createClient(fixture, { onError: (error) => errors.push(error) });
    client.start();
    const connection = await fixture.leader.waitForConnection();
    await connection.next('hello');
    connection.socket.close(1008, 'invalid frame');
    await waitFor(() => errors.length > 0);
    expect(errors[0]?.message).toMatch(/adapter type "codex"/);
    expect(errors[0]?.message).toMatch(/Upgrade the Leader/);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fixture.leader.connections).toHaveLength(1);
    expect(client.isConnected).toBe(false);
  });

  it('reconnects on other close codes before welcome', async () => {
    const fixture = await createFixture();
    const client = createClient(fixture, { random: () => 0.5 });
    client.start();
    const first = await fixture.leader.waitForConnection();
    await first.next('hello');
    first.socket.close(1001, 'going away');
    const second = await fixture.leader.waitForConnection(2, 5000);
    await second.next('hello');
    second.send(welcomeFrame());
    await second.next('heartbeat');
    expect(client.isConnected).toBe(true);
  });

  it('handles a Leader reject without reconnecting', async () => {
    const fixture = await createFixture();
    let reject!: (reason: string) => void;
    const rejected = new Promise<string>((resolve) => { reject = resolve; });
    const client = createClient(fixture, { onReject: reject });
    client.start();
    const connection = await fixture.leader.waitForConnection();
    await connection.next('hello');
    connection.send({ kind: 'reject', reason: 'bad_token' });
    await expect(rejected).resolves.toBe('bad_token');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fixture.leader.connections).toHaveLength(1);
    expect(client.isConnected).toBe(false);
  });

  it('journals, replays, and ACKs transcripts while sending task events first', async () => {
    const fixture = await createFixture();
    const client = createClient(fixture, { random: () => 0 });
    client.start();
    const first = await fixture.leader.waitForConnection();
    await first.next('hello');
    first.send(welcomeFrame({ capabilities: ['transcript-v1'], resendUnackedSec: 1 }));
    await first.next('heartbeat');
    const batch = { sid: 'sid-1', taskId: 1, events: [{ kind: 'status' as const, text: 'working', seq: 1, at: 1234 }] };
    const msgId = client.enqueueTranscript(batch)!;
    const eventId = client.enqueueEvent({ type: 'session.opened', inReplyTo: 'open', sid: 'sid-1', ok: true });
    await first.next('evt', (frame) => frame.msgId === eventId);
    const transcript = await first.next('transcript');
    expect(transcript).toEqual({ kind: 'transcript', msgId, ...batch });
    expect(first.frames.findIndex((frame) => frame.kind === 'evt')).toBeLessThan(first.frames.findIndex((frame) => frame.kind === 'transcript'));
    expect(await first.next('transcript', () => true, 2500)).toEqual(transcript);
    await fixture.leader.restart();
    await waitFor(() => !client.isConnected);
    const offlineId = client.enqueueTranscript({ ...batch, events: [{ kind: 'status', text: 'offline', seq: 2, at: 2345 }] });
    expect(offlineId).not.toBeNull();
    const second = await fixture.leader.waitForConnection(2, 5000);
    await second.next('hello');
    second.send(welcomeFrame({ capabilities: ['transcript-v1'] }));
    await second.next('heartbeat');
    expect(await second.next('transcript')).toEqual(transcript);
    expect(await second.next('transcript', (frame) => frame.msgId === offlineId)).toMatchObject({ events: [{ seq: 2, text: 'offline' }] });
    second.send({ kind: 'ack', msgId });
    second.send({ kind: 'ack', msgId: offlineId! });
    await waitFor(() => fixture.journal.nextTranscript() === null);
    expect(fixture.journal.nextTranscript()).toBeNull();
  });

  it('drops transcripts for old Leaders, before welcome, and after disconnect', async () => {
    const fixture = await createFixture();
    const client = createClient(fixture);
    const batch = { sid: 'sid-1', taskId: 1, events: [{ kind: 'status' as const, text: 'working', seq: 1, at: 1 }] };
    expect(client.enqueueTranscript(batch)).toBeNull();
    fixture.journal.enqueueTranscript(batch);
    client.start();
    const connection = await fixture.leader.waitForConnection();
    await connection.next('hello');
    connection.send(welcomeFrame());
    await connection.next('heartbeat');
    expect(client.supportsTranscripts).toBe(false);
    expect(client.enqueueTranscript(batch)).toBeNull();
    expect(fixture.journal.nextTranscript()).toBeNull();
    expect(connection.frames.some((frame) => frame.kind === 'transcript')).toBe(false);
    await client.stop();
    expect(client.enqueueTranscript(batch)).toBeNull();
  });

  it('defers transcript sends under socket pressure while task events remain immediate', async () => {
    const fixture = await createFixture();
    const client = createClient(fixture);
    client.start();
    const connection = await fixture.leader.waitForConnection();
    await connection.next('hello');
    connection.send(welcomeFrame({ capabilities: ['transcript-v1'] }));
    await connection.next('heartbeat');
    const pressure = vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockReturnValue(100000);
    client.enqueueTranscript({ sid: 'sid-1', taskId: 1, events: [{ kind: 'status', text: 'queued', seq: 1, at: 1 }] });
    const eventId = client.enqueueEvent({ type: 'session.opened', inReplyTo: 'open', sid: 'sid-1', ok: true });
    await connection.next('evt', (frame) => frame.msgId === eventId);
    expect(connection.frames.some((frame) => frame.kind === 'transcript')).toBe(false);
    pressure.mockRestore();
    expect(await connection.next('transcript')).toMatchObject({ sid: 'sid-1', events: [{ text: 'queued' }] });
  });

  it('allows plaintext connections to private and public Leaders', async () => {
    const fixture = await createFixture();
    const remoteConfig = parseNodeConfig({
      ...fixture.config,
      leaderUrl: 'ws://leader.example.com/ws/node',
    });
    const publicClient = new LeaderClient({ config: remoteConfig, journal: fixture.journal, onCommand: () => {} });
    expect(publicClient.url).toBe('ws://leader.example.com/ws/node');
    const lanConfig = parseNodeConfig({ ...fixture.config, leaderUrl: 'ws://192.168.1.20:7420/ws/node' });
    expect(new LeaderClient({ config: lanConfig, journal: fixture.journal, onCommand: () => {} }).url).toBe('ws://192.168.1.20:7420/ws/node');
    const localhostConfig = parseNodeConfig({ ...fixture.config, leaderUrl: 'ws://localhost:7420' });
    const local = new LeaderClient({ config: localhostConfig, journal: fixture.journal, onCommand: () => {} });
    expect(local.url).toBe('ws://localhost:7420/ws/node');
  });
});

async function createFixture(): Promise<{ leader: FakeLeader; journal: NodeJournal; config: NodeConfig }> {
  const leader = new FakeLeader();
  await leader.start();
  leaders.push(leader);
  const dir = await mkdtemp(join(tmpdir(), 'quorum-node-ws-'));
  tempDirs.push(dir);
  const journal = await openJournal(join(dir, 'data'));
  journals.push(journal);
  const config = parseNodeConfig({
    leaderUrl: leader.url,
    agentId: 'agent-1',
    token: 'secret',
    ownerName: 'Alice',
    repoRemoteUrl: 'https://example.invalid/repo.git',
    gitIdentity: { name: 'Alice', email: 'alice@example.invalid' },
    adapter: { type: 'mock', scriptPath: join(dir, 'mock-script.json') },
  });
  return { leader, journal, config };
}

function createClient(
  fixture: { leader: FakeLeader; journal: NodeJournal; config: NodeConfig },
  overrides: Partial<ConstructorParameters<typeof LeaderClient>[0]> = {},
): LeaderClient {
  const client = new LeaderClient({
    config: fixture.config,
    journal: fixture.journal,
    onCommand: () => {},
    ...overrides,
  });
  clients.push(client);
  return client;
}

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Condition did not become true');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
