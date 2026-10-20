import type { AgentEvent, IssueView, MessageView, TaskEventView, TranscriptSession } from '@quorum/protocol';
import { describeMessage, describeTaskEvent } from './messages.js';

export interface HumanAction {
  id: string;
  at: number;
  text: string;
  directiveId?: string;
  comment?: string;
}

export interface ChatEntry {
  id: string;
  at: number;
  speaker: string;
  kind: 'text' | 'thinking' | 'tool' | 'status' | 'message' | 'human' | 'event';
  text: string;
  sid?: string;
  seq?: number;
  failed?: boolean;
}

export function mergeTranscript(current: TranscriptSession[], incoming: TranscriptSession[]): TranscriptSession[] {
  const sessions = new Map(current.map((session) => [session.sid, session]));
  for (const session of incoming) {
    const previous = sessions.get(session.sid);
    const events = new Map(previous?.events.map((event) => [event.seq, event]) ?? []);
    for (const event of session.events) if (!events.has(event.seq)) events.set(event.seq, event);
    sessions.set(session.sid, { ...session, events: [...events.values()].sort((a, b) => a.seq - b.seq) });
  }
  return [...sessions.values()].sort((a, b) => a.sid.localeCompare(b.sid));
}

function toolText(call: Extract<AgentEvent, { kind: 'tool_call' }> | undefined, result?: Extract<AgentEvent, { kind: 'tool_result' }>): string {
  const kind = call?.toolKind ?? 'other';
  const icon = kind === 'bash' ? '$' : kind === 'edit' || kind === 'write' ? '✎' : '▸';
  const summary = call?.argsSummary || call?.paths?.join(' · ') || '';
  const outcome = result ? `${result.ok ? 'ok' : 'failed'}${result.exitCode === undefined ? '' : ` · exit ${result.exitCode}`}` : 'running';
  return `${icon} ${call ? kind === 'other' ? call.name : kind : 'tool'} ${summary} · ${outcome}`;
}

function sessionEntries(session: TranscriptSession, active: boolean): ChatEntry[] {
  const entries: ChatEntry[] = [];
  const texts = new Map<string, ChatEntry>();
  const thinking = new Map<string, ChatEntry>();
  const tools = new Map<string, { entry: ChatEntry; call?: Extract<AgentEvent, { kind: 'tool_call' }>; result?: Extract<AgentEvent, { kind: 'tool_result' }> }>();
  let previous: AgentEvent | undefined;
  let anonymousText = '';
  let anonymousThinking = '';
  let status: ChatEntry | undefined;
  for (const event of session.events) {
    const base = { id: `${session.sid}:${event.seq}`, sid: session.sid, seq: event.seq, at: event.at, speaker: `${session.agentId} [${session.profile}]` };
    if (event.kind === 'text') {
      if (!event.messageId && previous?.kind !== 'text') anonymousText = base.id;
      const key = event.messageId ?? anonymousText;
      let entry = texts.get(key);
      if (!entry) {
        entry = { ...base, kind: 'text', text: '' };
        texts.set(key, entry);
        entries.push(entry);
      }
      const continuingFinal = previous?.kind === 'text' && previous.mode === 'final' && previous.messageId === event.messageId && previous.seq + 1 === event.seq;
      if (event.mode === 'final' && !continuingFinal) entry.text = event.text;
      else entry.text += event.text;
    } else if (event.kind === 'thinking') {
      if (!event.messageId && previous?.kind !== 'thinking') anonymousThinking = base.id;
      const key = event.messageId ?? anonymousThinking;
      const entry = thinking.get(key);
      if (entry) entry.text += event.text;
      else {
        const next: ChatEntry = { ...base, kind: 'thinking', text: event.text };
        thinking.set(key, next);
        entries.push(next);
      }
    } else if (event.kind === 'tool_call' || event.kind === 'tool_result') {
      let pair = tools.get(event.id);
      if (!pair) {
        const entry: ChatEntry = { ...base, kind: 'tool', text: '' };
        pair = { entry };
        tools.set(event.id, pair);
        entries.push(entry);
      }
      if (event.kind === 'tool_call') pair.call = event;
      else pair.result = event;
      pair.entry.text = toolText(pair.call, pair.result);
      pair.entry.failed = pair.result?.ok === false;
    } else if (event.kind === 'status') {
      status = { ...base, kind: 'status', text: event.text };
    }
    previous = event;
  }
  if (active && status) entries.push(status);
  return entries;
}

export function buildChat(input: {
  messages: MessageView[];
  events: TaskEventView[];
  transcripts: TranscriptSession[];
  human?: HumanAction[];
  issues?: IssueView[];
  activeSids?: ReadonlySet<string>;
}): ChatEntry[] {
  const entries = input.transcripts.flatMap((session) => sessionEntries(session, input.activeSids?.has(session.sid) ?? false));
  for (const message of input.messages) {
    const text = describeMessage(message);
    if (text !== null) entries.push({ id: `message:${message.id}`, at: message.createdAt, speaker: message.direction === 'to_node' ? `Leader › ${message.agentId}` : message.agentId, kind: 'message', text });
  }
  for (const event of input.events) {
    const human = /^(human|token):/.test(event.actor);
    entries.push({ id: `event:${event.id}`, at: event.at, speaker: human ? event.actor.replace(/^(human|token):/, 'Human · ') : event.actor, kind: human ? 'human' : 'event', text: describeTaskEvent(event) });
  }
  for (const action of input.human ?? []) entries.push({ ...action, speaker: 'You', kind: 'human' });
  for (const issue of input.issues ?? []) {
    if (issue.source !== 'human') continue;
    entries.push({ id: `issue:${issue.id}`, at: issue.createdAt, speaker: 'Human', kind: 'human', text: `[${issue.code}] ${issue.comment}` });
  }
  return entries.sort((a, b) => a.at - b.at || (a.sid === b.sid && a.seq !== undefined && b.seq !== undefined ? a.seq - b.seq : a.id.localeCompare(b.id)));
}

export function transcriptUsage(sessions: TranscriptSession[]): string {
  let input = 0;
  let output = 0;
  let context = 0;
  let hasInput = false;
  let hasOutput = false;
  let hasContext = false;
  for (const session of sessions) {
    let latestContext: number | undefined;
    for (const event of session.events) {
      if (event.kind !== 'usage') continue;
      hasInput ||= event.inputTokens !== undefined;
      hasOutput ||= event.outputTokens !== undefined;
      input += event.inputTokens ?? 0;
      output += event.outputTokens ?? 0;
      if (event.contextTokens !== undefined) latestContext = event.contextTokens;
    }
    if (latestContext !== undefined) { context += latestContext; hasContext = true; }
  }
  const counters = [hasInput ? `${input} in` : '', hasOutput ? `${output} out` : ''].filter(Boolean);
  return [counters.length ? `tokens ${counters.join(' / ')}` : '', hasContext ? `context ${context}` : ''].filter(Boolean).join(' · ');
}
