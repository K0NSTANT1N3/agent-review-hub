import { AgentEventSchema, MAX_AGENT_EVENT_BATCH, type AgentEvent, type TranscriptBatch } from '@quorum/protocol';
import type { AgentEventInput } from '../adapters/types.js';
import type { NodeJournal } from '../journal.js';

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
      const parsed = AgentEventSchema.parse({ ...input, seq: 1, at: Date.now() });
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
