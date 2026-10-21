import { describe, expect, it } from 'vitest';
import { buildChat } from '../src/chat-model.js';
import { filteredTasks, initialState, reducer } from '../src/store.js';
import { activeSids } from '../src/components/screen.js';
import { agentView, detail, fixtureState, humanIssue, message, sessionView, taskEvent, taskView, transcripts } from './fixtures.js';

describe('store', () => {
  it('merges live messages/events/transcripts that arrive before REST snapshots, with replay deduplication', () => {
    let state = initialState;
    state = reducer(state, { type: 'ui', event: { type: 'message.created', data: message({ id: 'live' }) } });
    state = reducer(state, { type: 'ui', event: { type: 'task.event', data: taskEvent({ id: 2 }) } });
    const appended = { ...transcripts()[0]!, taskId: 12 };
    state = reducer(state, { type: 'ui', event: { type: 'transcript.appended', data: appended } });
    state = reducer(state, { type: 'detail', detail: detail() });
    state = reducer(state, { type: 'transcript', taskId: 12, sessions: transcripts(), supported: true });
    state = reducer(state, { type: 'ui', event: { type: 'transcript.appended', data: appended } });
    expect(state.data[12]?.messages.map((item) => item.id)).toContain('live');
    expect(state.data[12]?.events).toHaveLength(2);
    expect(state.data[12]?.transcripts[0]?.events).toHaveLength(4);
  });

  it('does not overwrite a newer task row with a stale REST detail', () => {
    let state = reducer(initialState, { type: 'ui', event: { type: 'task.updated', data: taskView({ state: 'MERGED', updatedAt: 10000 }) } });
    state = reducer(state, { type: 'detail', detail: detail() });
    expect(state.tasks[0]?.state).toBe('MERGED');
  });

  it('applies every UI event and connection/error state', () => {
    let state = fixtureState();
    state = reducer(state, { type: 'connection', connection: 'reconnecting' });
    state = reducer(state, { type: 'error', error: 'oops' });
    state = reducer(state, { type: 'ui', event: { type: 'agent.updated', data: agentView({ status: 'offline' }) } });
    state = reducer(state, { type: 'ui', event: { type: 'session.updated', data: sessionView({ state: 'idle' }) } });
    state = reducer(state, { type: 'ui', event: { type: 'team.activity.updated', data: { activities: [], queue: [] } } });
    state = reducer(state, { type: 'ui', event: { type: 'task.needs_attention', data: { taskId: 12, reason: 'escalated', message: 'help' } } });
    expect(state).toMatchObject({ connection: 'reconnecting', error: 'oops', agents: [{ status: 'offline' }, {}], sessions: [{ state: 'idle' }], activities: [] });
    expect(reducer(state, { type: 'ui', event: { type: 'message.created', data: message({ taskId: null }) } })).toBe(state);
  });

  it('updates the result of an asked directive in the human chat', () => {
    let state = reducer(fixtureState(), { type: 'human', taskId: 12, action: { id: 'human', directiveId: 'd', at: 9000, text: 'Asked agent: why?\nResult: queued' } });
    state = reducer(state, { type: 'ui', event: { type: 'directive.updated', data: { id: 'd', requester: 'tazo', agentId: 'claude@bob', sessionId: 'd-sid', text: 'why?', state: 'done', resultText: 'Because TTL', error: null, createdAt: 9000, finishedAt: 10000 } } });
    expect(buildChat(state.data[12]! ).find((entry) => entry.kind === 'human')?.text).toBe('Asked agent: why?\nResult: Because TTL');
  });

  it('filters tasks case-insensitively by title, id and state', () => {
    expect(filteredTasks([taskView()], 'rate-limit')).toHaveLength(1);
    expect(filteredTasks([taskView()], '12')).toHaveLength(1);
    expect(filteredTasks([taskView()], 'in_review')).toHaveLength(1);
    expect(filteredTasks([taskView()], 'other')).toEqual([]);
  });

  it('preserves live agent/session/activity changes while an older REST snapshot is pending', () => {
    let state = fixtureState();
    const revision = state.revision;
    state = reducer(state, { type: 'ui', event: { type: 'agent.updated', data: agentView({ status: 'offline' }) } });
    state = reducer(state, { type: 'ui', event: { type: 'session.updated', data: sessionView({ state: 'idle' }) } });
    state = reducer(state, { type: 'ui', event: { type: 'team.activity.updated', data: { activities: [], queue: [] } } });
    state = reducer(state, { type: 'agents', agents: [agentView()], revision });
    state = reducer(state, { type: 'sessions', sessions: [sessionView()], revision });
    const beforeActivity = state;
    state = reducer(state, { type: 'activities', activities: [], revision });
    expect(state).toBe(beforeActivity);
    expect(state.agents[0]?.status).toBe('offline');
    expect(state.sessions[0]?.state).toBe('idle');
    state = reducer(state, { type: 'agents', agents: [agentView()], revision: state.revision });
    expect(state.agents[0]?.status).toBe('online');
  });

  it('renders persisted human comments and removes the matching local echo after refresh', () => {
    let state = reducer(fixtureState(), { type: 'human', taskId: 12, action: { id: 'local', at: 9000, comment: 'Use Redis', text: 'Answered author: Use Redis' } });
    state = reducer(state, { type: 'detail', detail: detail({ issues: [humanIssue()] }) });
    expect(state.data[12]?.human).toEqual([]);
    expect(buildChat({ ...state.data[12]!, issues: state.data[12]?.detail?.issues }).find((entry) => entry.kind === 'human')).toMatchObject({ text: '[I1] Use Redis', at: 9000 });
  });

  it('replaces session events on a full REST load so Leader-pruned events disappear', () => {
    let state = initialState;
    const live = { ...transcripts()[0]!, taskId: 12, events: [
      { seq: 1, at: 1, kind: 'text' as const, mode: 'final' as const, text: 'pruned' },
      { seq: 2, at: 2, kind: 'text' as const, mode: 'final' as const, text: 'kept' },
    ] };
    state = reducer(state, { type: 'ui', event: { type: 'transcript.appended', data: live } });
    expect(state.data[12]?.transcripts[0]?.events.map((event) => event.seq)).toEqual([1, 2]);
    state = reducer(state, { type: 'transcript', taskId: 12, sessions: [{ sid: 'author', agentId: 'codex@tazo', profile: 'author', events: live.events.slice(1) }], supported: true });
    expect(state.data[12]?.transcripts[0]?.events.map((event) => event.seq)).toEqual([2]);
    state = reducer(state, { type: 'ui', event: { type: 'transcript.appended', data: { ...live, events: [{ seq: 3, at: 3, kind: 'text', mode: 'final', text: 'newer' }] } } });
    expect(state.data[12]?.transcripts[0]?.events.map((event) => event.seq)).toEqual([2, 3]);
  });

  it('clears transcript rows when falling back to messages only', () => {
    const state = reducer(fixtureState(), { type: 'transcript', taskId: 12, sessions: [], supported: false });
    expect(state.data[12]?.transcripts).toEqual([]);
    expect(state.data[12]?.messages.length).toBeGreaterThan(0);
  });

  it('uses locked session / conversation identities for live status and clears it for paused or terminal tasks', () => {
    const state = fixtureState();
    expect([...activeSids(state, state.tasks[0])]).toEqual(['reviewer']);
    expect([...activeSids({ ...state, sessions: [] }, state.tasks[0])]).toEqual(['reviewer']);
    expect([...activeSids(state, taskView({ state: 'AUTHORING' }))]).toEqual(['author']);
    expect([...activeSids(state, taskView({ state: 'PAUSED' }))]).toEqual([]);
    expect([...activeSids(state, taskView({ state: 'MERGED' }))]).toEqual([]);
  });
});
