import WebSocket from 'ws';
import { UiEventSchema, type UiEvent } from '@quorum/protocol';

// Subscribes to the Leader's /ws/ui with reconnect + backoff and forwards validated events.

const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;
/** A connection that stayed up this long counts as healthy even if no event arrived. */
const STABLE_MS = 10_000;
/** Policy violation: the Leader closes with this code when the token is unknown or revoked. */
const CLOSE_INVALID_TOKEN = 1008;

export interface UiStreamHandlers {
  onEvent: (e: UiEvent) => void;
  onConnection: (connected: boolean) => void;
  /** The Leader refused the token; the stream has stopped and will not reconnect. */
  onAuthError?: (reason: string) => void;
}

export class UiStream {
  private socket: WebSocket | null = null;
  private stopped = false;
  private delay = MIN_DELAY_MS;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly httpBase: string,
    private readonly token: string,
    private readonly handlers: UiStreamHandlers,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.socket?.terminate();
    this.socket = null;
  }

  private connect(): void {
    const url = new URL('/ws/ui', this.httpBase);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('token', this.token);
    const ws = new WebSocket(url);
    this.socket = ws;
    let openedAt: number | null = null;
    // The Leader accepts the upgrade before checking the token, so `open` alone does not mean healthy.
    ws.on('open', () => {
      openedAt = Date.now();
      this.handlers.onConnection(true);
    });
    ws.on('message', (raw) => {
      this.delay = MIN_DELAY_MS;
      try {
        const parsed = UiEventSchema.safeParse(JSON.parse(raw.toString()));
        if (parsed.success) this.handlers.onEvent(parsed.data);
      } catch {
        // ignore malformed frames
      }
    });
    ws.on('error', () => undefined);
    ws.on('close', (code, reason) => {
      if (this.socket === ws) this.socket = null;
      this.handlers.onConnection(false);
      if (this.stopped) return;
      if (code === CLOSE_INVALID_TOKEN) {
        this.stopped = true;
        this.handlers.onAuthError?.(reason.toString() || 'invalid token');
        return;
      }
      if (openedAt !== null && Date.now() - openedAt >= STABLE_MS) this.delay = MIN_DELAY_MS;
      this.timer = setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, MAX_DELAY_MS);
    });
  }
}
