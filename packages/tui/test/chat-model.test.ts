import { describe, expect, it } from 'vitest';
import type { AgentEvent, TranscriptSession } from '@quorum/protocol';
import { buildChat, mergeTranscript, transcriptUsage } from '../src/chat-model.js';
import { chatLines, viewport } from '../src/components/chat.js';
import { message, taskEvent } from './fixtures.js';

function session(events: AgentEvent[], sid = 's'): TranscriptSession { return { sid, agentId: sid, profile: 'author', events }; }
function chat(sessions: TranscriptSession[]) { return buildChat({ messages: [], events: [], transcripts: sessions }); }

describe('transcript model', () => {
  it('concatenates deltas by messageId, then replaces them with final text', () => {
    const deltas: AgentEvent[] = [{ kind: 'text', mode: 'delta', messageId: 'm', text: 'hel', seq: 1, at: 1 }, { kind: 'text', mode: 'delta', messageId: 'm', text: 'lo', seq: 2, at: 2 }];
    expect(chat([session(deltas)]).map((entry) => entry.text)).toEqual(['hello']);
    const final: AgentEvent = { kind: 'text', mode: 'final', messageId: 'm', text: 'Hello!', seq: 3, at: 3 };
    expect(chat([session([...deltas, final])])).toMatchObject([{ text: 'Hello!', at: 1 }]);
  });

  it('joins consecutive chunked finals across batches and replay without duplicating text', () => {
    let merged = mergeTranscript([], [session([{ kind: 'text', mode: 'delta', messageId: 'm', text: 'draft', seq: 1, at: 1 }])]);
    const first: AgentEvent = { kind: 'text', mode: 'final', messageId: 'm', text: 'a'.repeat(16384), seq: 2, at: 2 };
    merged = mergeTranscript(merged, [session([first])]);
    merged = mergeTranscript(merged, [session([first, { kind: 'text', mode: 'final', messageId: 'm', text: ' tail', seq: 3, at: 3 }])]);
    expect(chat(merged)[0]?.text).toBe(`${'a'.repeat(16384)} tail`);
    expect(merged[0]?.events).toHaveLength(3);
  });

  it('replaces an older snapshot when finals are not consecutive; keeps distinct message IDs', () => {
    expect(chat([session([
      { kind: 'text', mode: 'final', messageId: 'a', text: 'old', seq: 1, at: 1 },
      { kind: 'thinking', messageId: 'think', text: 'checking', seq: 2, at: 2 },
      { kind: 'text', mode: 'final', messageId: 'a', text: 'new', seq: 3, at: 3 },
      { kind: 'text', mode: 'final', messageId: 'b', text: 'other', seq: 4, at: 4 },
    ])]).filter((entry) => entry.kind === 'text').map((entry) => entry.text)).toEqual(['new', 'other']);
  });

  it('groups anonymous adjacent text and thinking, and collapses thinking to a dim line', () => {
    const entries = chat([session([
      { kind: 'text', mode: 'delta', text: 'draft', seq: 1, at: 1 },
      { kind: 'text', mode: 'final', text: 'done', seq: 2, at: 2 },
      { kind: 'thinking', text: 'one\n', seq: 3, at: 3 },
      { kind: 'thinking', text: 'two', seq: 4, at: 4 },
    ])]);
    expect(entries.map((entry) => entry.text)).toEqual(['done', 'one\ntwo']);
    expect(chatLines(entries, 40).filter((line) => line.dim)).toEqual([{ text: '  thinking · one two', dim: true, failed: undefined }]);
  });

  it('pairs tool results and calls per session into one indented line', () => {
    const events: AgentEvent[] = [
      { kind: 'tool_call', id: 'tool', name: 'Bash', toolKind: 'bash', argsSummary: 'pnpm test', seq: 1, at: 1 },
      { kind: 'tool_result', id: 'tool', ok: false, exitCode: 1, output: 'details stay local', seq: 2, at: 2 },
    ];
    const entries = chat([session(events), session(events, 'other')]);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ text: '$ bash pnpm test · failed · exit 1', failed: true });
    expect(chatLines(entries, 80)[1]?.text).toBe('  $ bash pnpm test · failed · exit 1');
    expect(chat([session([events[1]!])])[0]?.text).toContain('failed');
  });

  it('uses edit/read glyphs, paths, and a running result until completion', () => {
    expect(chat([session([
      { kind: 'tool_call', id: 'edit', name: 'Edit', toolKind: 'edit', argsSummary: '', paths: ['a.ts'], seq: 1, at: 1 },
      { kind: 'tool_call', id: 'read', name: 'Read', toolKind: 'read', argsSummary: 'b.ts', seq: 2, at: 2 },
    ])]).map((entry) => entry.text)).toEqual(['✎ edit a.ts · running', '▸ read b.ts · running']);
  });

  it('keeps tool outcome and exit code visible even when arguments exceed the pane width', () => {
    const entries = chat([session([
      { kind: 'tool_call', id: 'long', name: 'Bash', toolKind: 'bash', argsSummary: 'x'.repeat(256), seq: 1, at: 1 },
      { kind: 'tool_result', id: 'long', ok: false, exitCode: 127, output: '', seq: 2, at: 2 },
    ])]);
    const text = chatLines(entries, 40)[1]?.text;
    expect(text?.length).toBe(40);
    expect(text).toMatch(/failed · exit 127$/);
  });

  it('orders across sessions, messages and human actions, with independent seq namespaces', () => {
    const input = { messages: [message({ createdAt: 20 })], events: [taskEvent({ at: 35, actor: 'token:tazo', reason: 'human' })], human: [{ id: 'you', at: 40, text: 'Answer' }], transcripts: mergeTranscript([], [session([{ kind: 'text', mode: 'final', text: 'late', seq: 1, at: 30 }], 'b'), session([{ kind: 'text', mode: 'final', text: 'early', seq: 1, at: 10 }], 'a')]) };
    expect(buildChat(input).map((entry) => entry.kind)).toEqual(['text', 'message', 'text', 'human', 'human']);
    expect(buildChat(input).map((entry) => entry.at)).toEqual([10, 20, 30, 35, 40]);
  });

  it('sorts replayed events by seq and keeps session-local message/tool IDs independent', () => {
    const merged = mergeTranscript([session([{ kind: 'text', mode: 'delta', messageId: 'm', text: 'b', seq: 2, at: 2 }])], [session([{ kind: 'text', mode: 'delta', messageId: 'm', text: 'a', seq: 1, at: 1 }]), session([{ kind: 'text', mode: 'final', messageId: 'm', text: 'other', seq: 1, at: 1 }], 'other')]);
    expect(chat(merged).map((entry) => entry.text)).toEqual(['other', 'ab']);
  });

  it('shows only latest status for active sessions and sums usage without inventing context', () => {
    const sessions = [session([
      { kind: 'status', text: 'starting', seq: 1, at: 1 },
      { kind: 'usage', inputTokens: 10, outputTokens: 2, seq: 2, at: 2 },
      { kind: 'status', text: 'reading', seq: 3, at: 3 },
      { kind: 'usage', inputTokens: 20, outputTokens: 3, seq: 4, at: 4 },
    ])];
    expect(chat(sessions)).toEqual([]);
    expect(buildChat({ messages: [], events: [], transcripts: sessions, activeSids: new Set(['s']) })).toMatchObject([{ kind: 'status', text: 'reading' }]);
    expect(transcriptUsage(sessions)).toBe('tokens 30 in / 5 out');
    sessions[0]!.events.push({ kind: 'usage', contextTokens: 100, seq: 5, at: 5 }, { kind: 'usage', contextTokens: 90, seq: 6, at: 6 });
    expect(transcriptUsage(sessions)).toBe('tokens 30 in / 5 out · context 90');
    expect(transcriptUsage([session([{ kind: 'usage', contextTokens: 90, seq: 1, at: 1 }])])).toBe('context 90');
    expect(transcriptUsage([session([{ kind: 'usage', outputTokens: 0, seq: 1, at: 1 }])])).toBe('tokens 0 out');
  });
});

describe('quorum-json hiding', () => {
  const fence = (json: string) => `\`\`\`quorum-json\n${json}\n\`\`\``;

  it('keeps prose around a quorum-json block and drops a message that is only the block', () => {
    expect(chat([session([{ kind: 'text', mode: 'final', text: `Added the limit.\n${fence('{"status":"done","summary":"Added the limit."}')}`, seq: 1, at: 1 }])])[0]?.text).toBe('Added the limit.');
    expect(chat([session([{ kind: 'text', mode: 'final', text: `${fence('{"verdict":"approve"}')}\nlooks good`, seq: 1, at: 1 }])])[0]?.text).toBe('looks good');
    expect(chat([session([{ kind: 'text', mode: 'final', text: fence('{"status":"done"}'), seq: 1, at: 1 }])])).toEqual([]);
    expect(chat([session([{ kind: 'text', mode: 'final', text: '```ts\nconst x = 1;\n```', seq: 1, at: 1 }])])[0]?.text).toBe('```ts\nconst x = 1;\n```');
  });

  it('hides a quorum-json block split across deltas and consecutive final chunks', () => {
    const opening: AgentEvent[] = [
      { kind: 'text', mode: 'delta', messageId: 'm', text: 'Added the limit.\n```quo', seq: 1, at: 1 },
      { kind: 'text', mode: 'delta', messageId: 'm', text: 'rum-json\n{"status":"done"}\n', seq: 2, at: 2 },
    ];
    expect(chat([session(opening)])[0]?.text).toBe('Added the limit.');
    expect(chat([session([...opening, { kind: 'text', mode: 'delta', messageId: 'm', text: '```', seq: 3, at: 3 }])])[0]?.text).toBe('Added the limit.');
    const first: AgentEvent = { kind: 'text', mode: 'final', messageId: 'm', text: `prose\n\`\`\`quorum-json\n${'a'.repeat(100)}`, seq: 1, at: 1 };
    const second: AgentEvent = { kind: 'text', mode: 'final', messageId: 'm', text: `${'b'.repeat(100)}\n\`\`\``, seq: 2, at: 2 };
    expect(chat([session([first])])[0]?.text).toBe('prose');
    expect(chat([session([first, second])])[0]?.text).toBe('prose');
  });
});

describe('transition de-duplication', () => {
  it('merges a matching event into the richer message within 2s and keeps unmatched events', () => {
    const submitted = message({ id: 'submitted', direction: 'from_node', type: 'author.submitted', payload: { headCommit: '96b3fffabc', tests: { passed: true }, summary: 'Added the limit.' }, createdAt: 1000 });
    const matched = taskEvent({ id: 2, reason: 'author_submitted', toState: 'AWAITING_REVIEWER', actor: 'agent:codex@tazo', at: 1500 });
    const unmatched = taskEvent({ id: 3, reason: 'merge_started', toState: 'MERGING', actor: 'leader', at: 1600 });
    const entries = buildChat({ messages: [submitted], events: [matched, unmatched], transcripts: [] });
    expect(entries.map((entry) => ({ kind: entry.kind, text: entry.text }))).toEqual([
      { kind: 'message', text: 'codex@tazo submitted 96b3fff — tests passed → Awaiting reviewer\nAdded the limit.' },
      { kind: 'event', text: 'merge started · MERGING' },
    ]);
  });

  it('does not merge outside 2s, and pairs review assignment with the start message', () => {
    const late = message({ id: 'late', direction: 'from_node', type: 'author.submitted', payload: { headCommit: '96b3fffabc', tests: { passed: true } }, createdAt: 4000 });
    const early = taskEvent({ id: 2, reason: 'author_submitted', toState: 'AWAITING_REVIEWER', at: 1000 });
    expect(buildChat({ messages: [late], events: [early], transcripts: [] }).map((entry) => entry.kind)).toEqual(['event', 'message']);
    const start = message({ id: 'review', type: 'review.start', payload: { round: 1 }, createdAt: 2000 });
    const assigned = taskEvent({ id: 4, reason: 'reviewer_assigned', toState: 'IN_REVIEW', at: 2000 });
    expect(buildChat({ messages: [start], events: [assigned], transcripts: [] })).toMatchObject([{ kind: 'message', text: 'Leader asked codex@tazo to review (round 1) → In review' }]);
  });
});

it('keeps a scrolled viewport anchored when new lines arrive, and follows with null top', () => {
  expect(viewport([1, 2, 3, 4], 2, null)).toEqual([3, 4]);
  expect(viewport([1, 2, 3, 4, 5], 2, 1)).toEqual([2, 3]);
  expect(viewport([1, 2, 3, 4, 5], 2, null)).toEqual([4, 5]);
});
