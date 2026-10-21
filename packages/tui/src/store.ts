import type { AgentView, DirectiveView, MessageView, SessionView, TaskDetail, TaskEventView, TaskView, TeamActivityView, TranscriptSession, UiEvent } from '@quorum/protocol';
import { mergeTranscript, replaceTranscript, type HumanAction } from './chat-model.js';
import type { ConnectionState } from './ws-stream.js';

export interface TaskData {
  detail?: TaskDetail;
  messages: MessageView[];
  events: TaskEventView[];
  transcripts: TranscriptSession[];
  transcriptSupported?: boolean;
  human: HumanAction[];
}

export interface State {
  tasks: TaskView[];
  agents: AgentView[];
  sessions: SessionView[];
  activities: TeamActivityView[];
  data: Record<number, TaskData>;
  connection: ConnectionState;
  revision: number;
  liveAgents: Record<string, number>;
  liveSessions: Record<string, number>;
  liveActivityRevision: number;
  error?: string;
}

export const initialState: State = { tasks: [], agents: [], sessions: [], activities: [], data: {}, connection: 'connecting', revision: 0, liveAgents: {}, liveSessions: {}, liveActivityRevision: 0 };
export function emptyTaskData(): TaskData { return { messages: [], events: [], transcripts: [], human: [] }; }

export type StoreAction =
  | { type: 'connection'; connection: ConnectionState }
  | { type: 'error'; error?: string }
  | { type: 'tasks'; tasks: TaskView[] }
  | { type: 'agents'; agents: AgentView[]; revision?: number }
  | { type: 'sessions'; sessions: SessionView[]; revision?: number }
  | { type: 'activities'; activities: TeamActivityView[]; revision?: number }
  | { type: 'detail'; detail: TaskDetail }
  | { type: 'transcript'; taskId: number; sessions: TranscriptSession[]; supported: boolean }
  | { type: 'human'; taskId: number; action: HumanAction }
  | { type: 'ui'; event: UiEvent };

function upsert<T extends { id: string | number }>(current: T[], incoming: T[]): T[] {
  const values = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) values.set(item.id, item);
  return [...values.values()];
}

function mergeTasks(current: TaskView[], incoming: TaskView[]): TaskView[] {
  return upsert(current, incoming.filter((task) => !current.some((old) => old.id === task.id && old.updatedAt > task.updatedAt)))
    .sort((a, b) => b.id - a.id);
}

function updateData(state: State, taskId: number, change: (data: TaskData) => TaskData): State {
  return { ...state, data: { ...state.data, [taskId]: change(state.data[taskId] ?? emptyTaskData()) } };
}

function updateDirective(state: State, directive: DirectiveView): State {
  let next = state;
  for (const [id, data] of Object.entries(state.data)) {
    const action = data.human.find((item) => item.directiveId === directive.id);
    if (!action) continue;
    next = updateData(next, Number(id), (data) => ({ ...data, human: upsert(data.human, [{ ...action, text: `${action.text.split('\nResult:')[0]}\nResult: ${directive.resultText ?? directive.error ?? directive.state}` }]) }));
  }
  return next;
}

export function reducer(state: State, action: StoreAction): State {
  switch (action.type) {
    case 'connection': return { ...state, connection: action.connection };
    case 'error': return { ...state, error: action.error };
    case 'tasks': return { ...state, tasks: mergeTasks(state.tasks, action.tasks) };
    case 'agents': return { ...state, agents: upsert(action.agents, state.agents.filter((item) => (state.liveAgents[item.id] ?? 0) > (action.revision ?? Infinity))) };
    case 'sessions': return { ...state, sessions: upsert(action.sessions, state.sessions.filter((item) => (state.liveSessions[item.id] ?? 0) > (action.revision ?? Infinity))) };
    case 'activities': return action.revision !== undefined && state.liveActivityRevision > action.revision ? state : { ...state, activities: action.activities };
    case 'detail': {
      const next = { ...state, tasks: mergeTasks(state.tasks, [action.detail.task]) };
      return updateData(next, action.detail.task.id, (data) => ({
        ...data, detail: action.detail,
        messages: upsert(action.detail.messages, data.messages), events: upsert(action.detail.events, data.events),
        human: data.human.filter((item) => !item.comment || !action.detail.issues.some((issue) => issue.source === 'human' && issue.comment === item.comment)),
      }));
    }
    case 'transcript': return updateData(state, action.taskId, (data) => ({ ...data, transcriptSupported: action.supported, transcripts: action.supported ? replaceTranscript(action.sessions) : [] }));
    case 'human': return updateData(state, action.taskId, (data) => ({ ...data, human: upsert(data.human, [action.action]) }));
    case 'ui': {
      const event = action.event;
      switch (event.type) {
        case 'task.updated': return { ...state, tasks: mergeTasks(state.tasks, [event.data]) };
        case 'agent.updated': return { ...state, revision: state.revision + 1, agents: upsert(state.agents, [event.data]), liveAgents: { ...state.liveAgents, [event.data.id]: state.revision + 1 } };
        case 'session.updated': return { ...state, revision: state.revision + 1, sessions: upsert(state.sessions, [event.data]), liveSessions: { ...state.liveSessions, [event.data.id]: state.revision + 1 } };
        case 'team.activity.updated': return { ...state, revision: state.revision + 1, activities: event.data.activities, liveActivityRevision: state.revision + 1 };
        case 'task.event': return updateData(state, event.data.taskId, (data) => ({ ...data, events: upsert(data.events, [event.data]) }));
        case 'message.created': return event.data.taskId === null ? state : updateData(state, event.data.taskId, (data) => ({ ...data, messages: upsert(data.messages, [event.data]) }));
        case 'transcript.appended': return updateData(state, event.data.taskId, (data) => ({ ...data, transcriptSupported: true, transcripts: mergeTranscript(data.transcripts, [event.data]) }));
        case 'directive.updated': return updateDirective(state, event.data);
        case 'task.needs_attention': return state;
      }
    }
  }
}

export function filteredTasks(tasks: TaskView[], filter: string): TaskView[] {
  const query = filter.toLowerCase();
  return tasks.filter((task) => `${task.id} ${task.title} ${task.state}`.toLowerCase().includes(query));
}
