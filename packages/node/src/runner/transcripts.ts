import { homedir } from 'node:os';
import { AgentEventSchema, MAX_AGENT_EVENT_BATCH, type AgentEvent, type TranscriptBatch } from '@quorum/protocol';
import { redactHomeText } from '../adapters/event-utils.js';
import type { AgentEventInput } from '../adapters/types.js';
import type { NodeJournal } from '../journal.js';

export { redactHomeText, sanitizeFailureMessage, MAX_FAILURE_MESSAGE_CHARS } from '../adapters/event-utils.js';

/** Agents print absolute paths. The owner's home directory, and so their username, stays on this machine. */
export function redactHome(input: AgentEventInput, home: string = homedir()): AgentEventInput {
  if (home.length < 2) return input;
  const redact = (value: unknown): unknown => typeof value === 'string' ? redactHomeText(value, home)
    : Array.isArray(value) ? value.map(redact) : value;
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, redact(value)])) as AgentEventInput;
}

/** One adapter turn; sequences belong to the Quorum session, not the native session. */
export class TurnTranscript {
  private events: AgentEvent[] = [];
  private bytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private readonly journal: NodeJournal,
    private readonly sid: string,
    private readonly taskId: number | undefined,
    private readonly enabled: () => boolean,
    private readonly enqueue: (batch: TranscriptBatch) => void,
    private readonly onError: (error: unknown) => void,
  ) {}

  readonly onEvent = (input: AgentEventInput): void => {
    if (this.closed || this.taskId === undefined || !this.enabled()) return;
    try {
      const parsed = AgentEventSchema.parse({ ...redactHome(input), seq: 1, at: Date.now() });
      parsed.seq = this.journal.nextTranscriptSeq(this.sid);
      this.events.push(parsed);
      this.bytes += Buffer.byteLength(JSON.stringify(parsed));
      if (this.events.length >= MAX_AGENT_EVENT_BATCH || this.bytes >= 65536) this.flush();
      else if (this.timer === null) this.timer = setTimeout(() => this.flush(), 250);
    } catch (error) {
      this.onError(error);
    }
  };

  close(): void {
    this.closed = true;
    this.flush();
  }

  private flush(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const events = this.events;
    this.events = [];
    this.bytes = 0;
    if (events.length === 0 || this.taskId === undefined || !this.enabled()) return;
    try {
      this.enqueue({ sid: this.sid, taskId: this.taskId, events });
    } catch (error) {
      this.onError(error);
    }
  }
}
