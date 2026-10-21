import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TranscriptBatch } from '@quorum/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openJournal, type NodeJournal } from '../../src/journal.js';
import { MAX_FAILURE_MESSAGE_CHARS, redactHome, sanitizeFailureMessage, TurnTranscript } from '../../src/runner/transcripts.js';

describe('turn transcripts', () => {
  let root: string;
  let journal: NodeJournal;
  let batches: TranscriptBatch[];
  let enabled: boolean;
  const errors = vi.fn();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'quorum-transcripts-'));
    journal = await openJournal(root);
    batches = [];
    enabled = true;
    errors.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(1234);
  });

  afterEach(async () => {
    vi.useRealTimers();
    journal.close();
    await rm(root, { recursive: true, force: true });
  });

  function turn(sid = 'sid-1', taskId: number | undefined = 1): TurnTranscript {
    return new TurnTranscript(journal, sid, taskId, () => enabled, (batch) => { batches.push(batch); }, errors);
  }

  it('flushes at 100 events, 250ms, and turn end with persisted per-session stamps', async () => {
    const first = turn();
    for (let i = 0; i < 100; i++) first.onEvent({ kind: 'status', text: String(i) });
    expect(batches).toHaveLength(1);
    expect(batches[0]!.events).toHaveLength(100);
    expect(batches[0]!.events[0]).toEqual({ kind: 'status', text: '0', seq: 1, at: 1234 });
    first.onEvent({ kind: 'status', text: 'timer' });
    vi.advanceTimersByTime(249);
    expect(batches).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(batches[1]!.events[0]!.seq).toBe(101);
    first.onEvent({ kind: 'status', text: 'end' });
    first.close();
    expect(batches[2]!.events[0]!.seq).toBe(102);
    first.onEvent({ kind: 'status', text: 'late' });
    vi.advanceTimersByTime(1000);
    expect(batches).toHaveLength(3);

    journal.close();
    journal = await openJournal(root);
    const restarted = turn('sid-1', 2);
    restarted.onEvent({ kind: 'status', text: 'restart' });
    restarted.close();
    const other = turn('sid-2');
    other.onEvent({ kind: 'status', text: 'independent' });
    other.close();
    expect(batches[3]).toMatchObject({ sid: 'sid-1', taskId: 2, events: [{ seq: 103 }] });
    expect(batches[4]).toMatchObject({ sid: 'sid-2', taskId: 1, events: [{ seq: 1 }] });
  });

  it('drops events without capability, including a buffered batch after capability loss', () => {
    enabled = false;
    const first = turn();
    first.onEvent({ kind: 'status', text: 'old leader' });
    enabled = true;
    first.onEvent({ kind: 'status', text: 'new leader' });
    enabled = false;
    first.close();
    expect(batches).toEqual([]);
    enabled = true;
    const second = turn();
    second.onEvent({ kind: 'status', text: 'next turn' });
    second.close();
    expect(batches[0]!.events[0]!.seq).toBe(2);
  });

  it('bounds large partial batches and isolates invalid adapter events and delivery failures', () => {
    const first = turn();
    first.onEvent({ kind: 'status', text: '' });
    for (let i = 0; i < 10; i++) first.onEvent({ kind: 'thinking', text: 'a'.repeat(16384) });
    expect(batches.length).toBeGreaterThan(0);
    expect(batches.every((batch) => batch.events.length <= 4)).toBe(true);
    first.close();
    const broken = new TurnTranscript(journal, 'sid-1', 1, () => true, () => { throw new Error('disk full'); }, errors);
    broken.onEvent({ kind: 'status', text: 'valid' });
    expect(() => broken.close()).not.toThrow();
    expect(errors).toHaveBeenCalledTimes(2);
  });
});

describe('redactHome', () => {
  it('replaces the owner home directory in every string field and path', () => {
    expect(redactHome({
      kind: 'tool_call', id: 'c1', name: 'bash', toolKind: 'bash',
      argsSummary: "rtk read /Users/ana/Documents/vault/index.md", paths: ['/Users/ana/.quorum/workspace/s1/a.ts', 'src/b.ts'],
    }, '/Users/ana')).toEqual({
      kind: 'tool_call', id: 'c1', name: 'bash', toolKind: 'bash',
      argsSummary: 'rtk read ~/Documents/vault/index.md', paths: ['~/.quorum/workspace/s1/a.ts', 'src/b.ts'],
    });
    expect(redactHome({ kind: 'tool_result', id: 'c1', ok: true, exitCode: 0, output: '/Users/ana/x\n/Users/ana/y' }, '/Users/ana'))
      .toEqual({ kind: 'tool_result', id: 'c1', ok: true, exitCode: 0, output: '~/x\n~/y' });
  });

  it('leaves events alone when the home directory is the filesystem root', () => {
    const event = { kind: 'text', mode: 'final', text: '/etc/hosts' } as const;
    expect(redactHome(event, '/')).toBe(event);
  });

  it('redacts home paths in failure messages and caps them at 2048 characters', () => {
    expect(sanitizeFailureMessage('failed /Users/ana/.codex/auth.json', '/Users/ana')).toBe('failed ~/.codex/auth.json');
    const sanitized = sanitizeFailureMessage(`/Users/ana/${'x'.repeat(3000)}`, '/Users/ana');
    expect(sanitized.startsWith('~/')).toBe(true);
    expect(sanitized.length).toBe(MAX_FAILURE_MESSAGE_CHARS);
    expect(sanitized).not.toContain('/Users/ana');
  });
});

