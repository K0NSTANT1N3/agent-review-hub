import { QUORUM_JSON_FENCE, type AgentEvent, type IssueView, type MessageView, type TaskEventView, type TranscriptSession } from '@quorum/protocol';
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
  return entries.flatMap((entry) => {
    if (entry.kind !== 'text') return [entry];
    const text = stripQuorumJson(entry.text);
    return text === '' ? [] : [{ ...entry, text }];
  });
}

const OPEN_FENCE = new RegExp(`^ {0,3}\`\`\`${QUORUM_JSON_FENCE}[ \\t]*\\r?$`, 'gm');
const CLOSE_FENCE = /^ {0,3}```[ \t]*\r?$/gm;

/** Drop machine ```quorum-json blocks, including a fence still arriving across deltas. */
function stripQuorumJson(text: string): string {
  let remaining = text;
  let kept = '';
  while (remaining.length > 0) {
    OPEN_FENCE.lastIndex = 0;
    const open = OPEN_FENCE.exec(remaining);
    if (open === null || open.index === undefined) {
      kept += remaining;
      break;
    }
    kept += remaining.slice(0, open.index);
    const afterOpening = open.index + open[0].length;
    const lineBreak = /^\r?\n/.exec(remaining.slice(afterOpening));
    const bodyStart = lineBreak === null ? remaining.length : afterOpening + lineBreak[0].length;
    CLOSE_FENCE.lastIndex = bodyStart;
    const close = CLOSE_FENCE.exec(remaining);
    if (close === null || close.index === undefined) break;
    remaining = remaining.slice(close.index + close[0].length).replace(/^\r?\n/, '');
  }
  const lastNl = kept.lastIndexOf('\n');
  const lastLine = lastNl === -1 ? kept : kept.slice(lastNl + 1);
  const fence = lastLine.replace(/[ \t]+$/g, '').replace(/^\s{0,3}/, '');
  const opener = `\`\`\`${QUORUM_JSON_FENCE}`;
  // A bare ``` is a legal close of some other fence; only hide an unambiguous quorum-json prefix.
  if (fence.length > 3 && opener.startsWith(fence)) kept = lastNl === -1 ? '' : kept.slice(0, lastNl);
  return kept.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '');
}

const TRANSITION_REASONS: Record<string, readonly string[]> = {
  'author.submitted': ['author_submitted', 'tests_failed'],
  'author.start': ['author_assigned'],
  'author.sync': ['merge_conflict'],
  'author.synced': ['sync_conflicts_resolved', 'sync_clean'],
  'review.start': ['reviewer_assigned'],
  'review.completed': ['review_approved', 'review_changes'],
};

function prettyState(state: string): string {
  const text = state.replaceAll('_', ' ').toLowerCase();
  return text === '' ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

function attachState(text: string, state: string): string {
  const index = text.indexOf('\n');
  const head = index === -1 ? text : text.slice(0, index);
  return `${head} → ${prettyState(state)}${index === -1 ? '' : text.slice(index)}`;
}

function pairedStates(messages: MessageView[], events: TaskEventView[]): { hiddenEvents: Set<number>; states: Map<string, string> } {
  const hiddenEvents = new Set<number>();
  const states = new Map<string, string>();
  const used = new Set<string>();
  for (const event of events) {
    let best: MessageView | undefined;
    let bestDt = Infinity;
    for (const message of messages) {
      if (used.has(message.id) || !TRANSITION_REASONS[message.type]?.includes(event.reason)) continue;
      const dt = Math.abs(message.createdAt - event.at);
      if (dt <= 2000 && dt < bestDt) { best = message; bestDt = dt; }
    }
    if (best === undefined) continue;
    used.add(best.id);
    hiddenEvents.add(event.id);
    states.set(best.id, event.toState);
  }
  return { hiddenEvents, states };
}

export function buildChat(input: {
  messages: MessageView[];
  events: TaskEventView[];
  transcripts: TranscriptSession[];
  human?: HumanAction[];
  issues?: IssueView[];
  activeSids?: ReadonlySet<string>;
}): ChatEntry[] {
  const { hiddenEvents, states } = pairedStates(input.messages, input.events);
  const entries = input.transcripts.flatMap((session) => sessionEntries(session, input.activeSids?.has(session.sid) ?? false));
  for (const message of input.messages) {
    const text = describeMessage(message);
    if (text === null) continue;
    const state = states.get(message.id);
    entries.push({ id: `message:${message.id}`, at: message.createdAt, speaker: message.direction === 'to_node' ? `Leader › ${message.agentId}` : message.agentId, kind: 'message', text: state === undefined ? text : attachState(text, state) });
  }
  for (const event of input.events) {
    if (hiddenEvents.has(event.id)) continue;
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
