import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseNodeConfig, type Command, type Event, type TaskBrief } from '@quorum/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { AdapterError, type AgentAdapter } from '../src/adapters/types.js';
import { startDaemon, type DaemonHandle } from '../src/daemon.js';
import { openJournal } from '../src/journal.js';
import { createTempRepo, type TempRepo } from './helpers/temp-repo.js';
import { FakeLeader, type FakeLeaderConnection, welcomeFrame } from './helpers/fake-leader.js';

interface Fixture {
  leader: FakeLeader;
  connection: FakeLeaderConnection;
  repo: TempRepo;
  daemon: DaemonHandle;
  dataDir: string;
  dispose(): Promise<void>;
}

const fixtures: Fixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
});

describe('Node daemon', () => {
  it('runs a full author and review flow and applies updated settings on the next heartbeat', async () => {
    const fixture = await createFixture();
    const hello = await fixture.connection.next('hello');
    expect(hello).toMatchObject({ agentId: 'daemon-test', adapterType: 'mock', trust: 'enforced', detectedAgents: expect.any(Array) });
    fixture.connection.send(welcomeFrame({ heartbeatIntervalSec: 1, capabilities: ['transcript-v1'] }));
    const heartbeat = await fixture.connection.next('heartbeat');
    expect(heartbeat.status.detectedAgents).toEqual(hello.detectedAgents);
    expect(fixture.daemon.status()).toMatchObject({ trust: 'enforced', detectedAgents: hello.detectedAgents });

    fixture.daemon.updateSettings({ paused: true });
    const updatedHeartbeat = await fixture.connection.next(
      'heartbeat',
      (frame) => frame.status.settings.paused,
      2500,
    );
    expect(updatedHeartbeat.status.settings.paused).toBe(true);
    expect(fixture.daemon.status().settings.paused).toBe(true);

    await sendCommand(fixture.connection, 'open-author', {
      type: 'session.open', sid: 'sid-author', profile: 'author',
    });
    await expectEvent(fixture.connection, 'session.opened', 'open-author');

    const task: TaskBrief = {
      id: 801,
      title: 'Daemon integration task',
      description: 'Exercise the Node daemon author and review command flow.',
      tags: [],
      requester: 'Test Owner',
    };
    await sendCommand(fixture.connection, 'author-start', {
      type: 'author.start', sid: 'sid-author', taskId: task.id, task,
      branch: 'quorum/task-801', continueExisting: false, issues: [], estimated: 100,
    });
    await expectEvent(fixture.connection, 'author.checkpoint', 'author-start', false);
    const submitted = await expectEvent(fixture.connection, 'author.submitted', 'author-start');
    expect(submitted).toMatchObject({
      type: 'author.submitted', status: 'done', filesChanged: ['src/daemon-result.txt'],
      tests: { passed: true },
    });
    if (submitted.type !== 'author.submitted') throw new Error('Expected author.submitted event');
    expect(await fixture.connection.next('transcript')).toMatchObject({ sid: 'sid-author', taskId: 801, events: [
      { kind: 'status', seq: 1 }, { kind: 'tool_call', seq: 2 }, { kind: 'tool_result', seq: 3 }, { kind: 'text', seq: 4 },
    ] });

    await sendCommand(fixture.connection, 'open-reviewer', {
      type: 'session.open', sid: 'sid-reviewer', profile: 'reviewer',
    });
    await expectEvent(fixture.connection, 'session.opened', 'open-reviewer');
    await sendCommand(fixture.connection, 'review-start', {
      type: 'review.start', sid: 'sid-reviewer', taskId: task.id,
      conversationId: 'conversation-801', round: 1, task, branch: 'quorum/task-801',
      baseCommit: submitted.baseCommit, headCommit: submitted.headCommit,
      testSummary: 'passed', priorIssues: [], estimated: 100,
    });
    const reviewed = await expectEvent(fixture.connection, 'review.completed', 'review-start');
    expect(reviewed).toMatchObject({
      type: 'review.completed',
      conversationId: 'conversation-801',
      output: { verdict: 'approve', summary: 'Looks good.', newIssues: [] },
    });
    expect(fixture.connection.errors).toEqual([]);
  }, 15_000);

  it('stops promptly without starting queued turns and leaves them for startup recovery', async () => {
    const started: string[] = [];
    let firstStarted!: () => void;
    const firstTurn = new Promise<void>((resolve) => { firstStarted = resolve; });
    const adapter: AgentAdapter = {
      createSession: () => Promise.resolve({ nativeId: 'native-stop' }),
      closeSession: () => Promise.resolve(),
      runTurn: (opts) => {
        started.push(/^QUORUM-DIRECTIVE:\s+(\S+)/m.exec(opts.prompt)?.[1] ?? opts.prompt);
        firstStarted();
        // Behaves like a long model turn that only ends when aborted.
        return new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => {
            reject(new AdapterError('CANCELLED', 'turn aborted'));
          }, { once: true });
        });
      },
    };
    const fixture = await createFixture({ adapter });
    await fixture.connection.next('hello');
    fixture.connection.send(welcomeFrame({ turnTimeoutSec: 1800 }));
    await fixture.connection.next('heartbeat');

    await sendCommand(fixture.connection, 'open-directive', {
      type: 'session.open', sid: 'sid-stop', profile: 'directive',
    });
    await expectEvent(fixture.connection, 'session.opened', 'open-directive');
    await sendCommand(fixture.connection, 'directive-active', {
      type: 'directive.run', sid: 'sid-stop', directiveId: 'active', requester: 'Alice', text: 'First.', estimated: 1,
    });
    await sendCommand(fixture.connection, 'directive-queued', {
      type: 'directive.run', sid: 'sid-stop', directiveId: 'queued', requester: 'Alice', text: 'Second.', estimated: 1,
    });
    await firstTurn;

    const stopStarted = Date.now();
    await fixture.daemon.stop();
    expect(Date.now() - stopStarted).toBeLessThan(3_000);
    expect(started).toEqual(['active']);

    const journal = await openJournal(fixture.dataDir);
    try {
      expect(journal.getCommand('directive-active')?.state).toBe('done');
      expect(journal.getCommand('directive-queued')?.state).toBe('received');
      expect(journal.recoverOnStartup()).toBe(1);
      expect(journal.unackedEvents().map((event) => event.evt)).toContainEqual(expect.objectContaining({
        type: 'turn.failed', inReplyTo: 'directive-queued', code: 'INTERRUPTED',
      }));
    } finally {
      journal.close();
    }
  }, 15_000);
});

async function createFixture(options: { adapter?: AgentAdapter } = {}): Promise<Fixture> {
  const leader = new FakeLeader();
  await leader.start();
  let repo: TempRepo | undefined;
  let daemon: DaemonHandle | undefined;
  const tempDir = await mkdtemp(join(tmpdir(), 'quorum-node-daemon-'));
  try {
    repo = await createTempRepo();
    const scriptPath = join(tempDir, 'mock-script.json');
    await writeFile(scriptPath, JSON.stringify({
      author: [{ match: { any: true }, turns: [{
        writeFiles: { 'src/daemon-result.txt': 'author completed\n' },
        reply: { status: 'done', summary: 'Added the daemon integration fixture.' },
      }] }],
      reviewer: [{ match: { any: true }, turns: [{
        reply: { verdict: 'approve', summary: 'Looks good.', previousIssues: [], newIssues: [] },
      }] }],
    }));
    const config = parseNodeConfig({
      leaderUrl: leader.url,
      agentId: 'daemon-test',
      token: 'test-token',
      ownerName: 'Test Owner',
      repoRemoteUrl: repo.remotePath,
      workspaceDir: repo.config.workspaceDir,
      dataDir: join(tempDir, 'data'),
      gitIdentity: repo.config.gitIdentity,
      adapter: { type: 'mock', scriptPath },
    });
    daemon = await startDaemon(config, {
      assumeIdle: true,
      ...(options.adapter === undefined ? {} : { adapter: options.adapter }),
    });
    const connection = await leader.waitForConnection();
    const fixture: Fixture = {
      leader,
      connection,
      repo,
      daemon,
      dataDir: config.dataDir,
      async dispose() {
        await daemon?.stop();
        await leader.stop();
        await repo?.dispose();
        await rm(tempDir, { recursive: true, force: true });
      },
    };
    fixtures.push(fixture);
    return fixture;
  } catch (error) {
    await daemon?.stop().catch(() => undefined);
    await leader.stop();
    await repo?.dispose();
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

async function sendCommand(connection: FakeLeaderConnection, msgId: string, cmd: Command): Promise<void> {
  connection.send({ kind: 'cmd', msgId, cmd });
  await connection.next('ack', (frame) => frame.msgId === msgId);
}

async function expectEvent(
  connection: FakeLeaderConnection,
  type: Event['type'],
  inReplyTo: string,
  requireReply = true,
): Promise<Event> {
  const frame = await connection.next('evt', (candidate) =>
    candidate.evt.type === type && (!requireReply || ('inReplyTo' in candidate.evt && candidate.evt.inReplyTo === inReplyTo)),
    10_000,
  );
  connection.send({ kind: 'ack', msgId: frame.msgId });
  return frame.evt;
}
