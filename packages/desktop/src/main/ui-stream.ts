import WebSocket from 'ws';
import { UiEventSchema, type UiEvent } from '@quorum/protocol';

// Subscribes to the Leader's /ws/ui with reconnect + backoff and forwards validated events.

export class UiStream {
  private socket: WebSocket | null = null;
  private stopped = false;
  private delay = 1000;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly httpBase: string,
    private readonly token: string,
    private readonly handlers: { onEvent: (e: UiEvent) => void; onConnection: (connected: boolean) => void },
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
    ws.on('open', () => {
      this.delay = 1000;
      this.handlers.onConnection(true);
    });
    ws.on('message', (raw) => {
      try {
        const parsed = UiEventSchema.safeParse(JSON.parse(raw.toString()));
        if (parsed.success) this.handlers.onEvent(parsed.data);
      } catch {
        // ignore malformed frames
      }
    });
    ws.on('error', () => undefined);
    ws.on('close', () => {
      if (this.socket === ws) this.socket = null;
      this.handlers.onConnection(false);
      if (this.stopped) return;
      this.timer = setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, 30_000);
    });
  }
}
