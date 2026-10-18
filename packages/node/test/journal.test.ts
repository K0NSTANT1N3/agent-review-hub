import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openJournal } from '../src/journal.js';
import type { Command } from '@quorum/protocol';

describe('node journal', () => {
  let root: string;
  let dataDir: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'quorum-node-journal-'));
    dataDir = join(root, 'data');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('records commands once and persists completion and outbox state across restart', async () => {
    let now = 100;
    const journal = await openJournal(dataDir, () => now++);
    const command: Command = { type: 'session.open', sid: 'sid-1', profile: 'author' };

    expect(journal.recordCommand('cmd-1', command)).toBe(true);
    expect(journal.recordCommand('cmd-1', command)).toBe(false);
    expect(journal.isProcessed('cmd-1')).toBe(true);
    expect(journal.isProcessed('missing')).toBe(false);
    journal.markRunning('cmd-1');

    const eventMsgId = journal.enqueueEvent({
      type: 'session.opened',
      inReplyTo: 'cmd-1',
      sid: 'sid-1',
      ok: true,
    });
    journal.markDone('cmd-1', eventMsgId);
    expect(journal.getCommand('cmd-1')).toMatchObject({
      state: 'done',
      resultEvtMsgId: eventMsgId,
      cmd: command,
    });
    expect(journal.unackedEvents()).toHaveLength(1);
    journal.close();

    const restarted = await openJournal(dataDir, () => now++);
    expect(restarted.isProcessed('cmd-1')).toBe(true);
    expect(restarted.getCommand('cmd-1')?.state).toBe('done');
    expect(restarted.recoverOnStartup()).toBe(0);
    expect(restarted.unackedEvents()).toHaveLength(1);
    expect(restarted.unackedEvents()[0]).toMatchObject({
      msgId: eventMsgId,
      evt: { type: 'session.opened', inReplyTo: 'cmd-1', sid: 'sid-1', ok: true },
    });
    expect(restarted.unackedEvents()[0]?.createdAt).toBeGreaterThan(100);

    restarted.markAcked(eventMsgId);
    expect(restarted.unackedEvents()).toEqual([]);
    restarted.close();
  });

  it('turns every interrupted running command into one durable INTERRUPTED event', async () => {
    let now = 500;
    const journal = await openJournal(dataDir, () => now++);
    const command: Command = {
      type: 'author.sync',
      sid: 'sid-2',
      taskId: 72,
      branch: 'quorum/task-72',
      mainBranch: 'main',
      estimated: 1000,
    };
    journal.recordCommand('cmd-running', command);
    journal.markRunning('cmd-running');
    journal.close();

    const restarted = await openJournal(dataDir, () => now++);
    expect(restarted.recoverOnStartup()).toBe(1);
    expect(restarted.recoverOnStartup()).toBe(0);

    const inbox = restarted.getCommand('cmd-running');
    expect(inbox?.state).toBe('done');
    expect(inbox?.resultEvtMsgId).toBeTruthy();
    expect(inbox?.finishedAt).not.toBeNull();
    expect(restarted.unackedEvents()).toHaveLength(1);
    expect(restarted.unackedEvents()[0]).toMatchObject({
      evt: {
        type: 'turn.failed',
        inReplyTo: 'cmd-running',
        sid: 'sid-2',
        taskId: 72,
        code: 'INTERRUPTED',
      },
    });
    expect(restarted.unackedEvents()[0]?.msgId).toBe(inbox?.resultEvtMsgId);
    restarted.close();

    const finalRestart = await openJournal(dataDir, () => now++);
    expect(finalRestart.recoverOnStartup()).toBe(0);
    expect(finalRestart.unackedEvents()).toHaveLength(1);
    finalRestart.close();
  });

  it('reports a queued turn command that never started exactly once', async () => {
    let now = 700;
    const journal = await openJournal(dataDir, () => now++);
    journal.recordCommand('cmd-queued', {
      type: 'directive.run',
      sid: 'sid-4',
      directiveId: 'directive-4',
      requester: 'Alice',
      text: 'Queued work.',
      estimated: 1,
    });
    journal.recordCommand('cmd-open', { type: 'session.open', sid: 'sid-5', profile: 'author' });
    journal.close();

    const restarted = await openJournal(dataDir, () => now++);
    expect(restarted.recoverOnStartup()).toBe(1);
    expect(restarted.recoverOnStartup()).toBe(0);
    expect(restarted.getCommand('cmd-queued')?.state).toBe('done');
    expect(restarted.getCommand('cmd-open')?.state).toBe('received');
    expect(restarted.unackedEvents()).toHaveLength(1);
    expect(restarted.unackedEvents()[0]).toMatchObject({
      evt: { inReplyTo: 'cmd-queued', sid: 'sid-4', code: 'INTERRUPTED' },
    });
    restarted.close();
  });

  it('supports session create, read, list, update, and delete', async () => {
    const journal = await openJournal(dataDir, () => 1234);
    const created = journal.createSession({
      sid: 'sid-3',
      nativeId: null,
      worktree: '/workspace/worktrees/sid-3',
      profile: 'reviewer',
      contextTokens: 0,
      state: 'open',
    });
    expect(created.createdAt).toBe(1234);
    expect(journal.getSession('sid-3')).toEqual(created);
    expect(journal.listSessions()).toEqual([created]);
    expect(journal.updateSession('sid-3', { nativeId: 'native-3', contextTokens: 900 })).toBe(true);
    expect(journal.getSession('sid-3')).toMatchObject({ nativeId: 'native-3', contextTokens: 900 });
    expect(journal.updateSession('missing', { state: 'closed' })).toBe(false);
    expect(journal.deleteSession('sid-3')).toBe(true);
    expect(journal.deleteSession('sid-3')).toBe(false);
    expect(journal.getSession('sid-3')).toBeNull();
    journal.close();
  });
});
