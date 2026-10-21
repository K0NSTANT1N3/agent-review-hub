import WebSocket from 'ws';
import { UI_WS_PATH, UiEventSchema, type UiEvent } from '@quorum/protocol';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'auth-error' | 'closed';

export interface StreamHandlers {
  onEvent: (event: UiEvent) => void;
  onConnection: (state: ConnectionState) => void;
  onAuthError: (reason: string) => void;
}

export type SocketFactory = (url: URL, token: string) => WebSocket;

// Matches the desktop stream: bearer upgrade, 1–30s backoff, 10s healthy reset, no retry on 1008.
export class UiStream {
  private socket: WebSocket | null = null;
  private stopped = true;
  private delay = 1000;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly httpBase: string,
    private readonly token: string,
    private readonly handlers: StreamHandlers,
    private readonly createSocket: SocketFactory = (url, token) => new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } }),
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.delay = 1000;
    this.handlers.onConnection('connecting');
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.socket?.terminate();
    this.socket = null;
  }

  private connect(): void {
    if (this.stopped) return;
    const url = new URL(UI_WS_PATH, this.httpBase);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = this.createSocket(url, this.token);
    this.socket = ws;
    let openedAt: number | null = null;
    ws.on('open', () => {
      if (this.stopped || this.socket !== ws) return;
      openedAt = Date.now();
      this.handlers.onConnection('connected');
    });
    ws.on('message', (raw) => {
      if (this.stopped || this.socket !== ws) return;
      this.delay = 1000;
      try {
        const parsed = UiEventSchema.safeParse(JSON.parse(raw.toString()));
        if (parsed.success) this.handlers.onEvent(parsed.data);
      } catch { /* Ignore malformed frames, as the desktop does. */ }
    });
    ws.on('error', () => undefined);
    ws.on('close', (code, reason) => {
      if (this.socket !== ws) return;
      this.socket = null;
      if (this.stopped) return;
      if (code === 1008) {
        this.stopped = true;
        this.handlers.onConnection('auth-error');
        this.handlers.onAuthError(reason.toString() || 'Invalid or revoked token');
        return;
      }
      this.handlers.onConnection('reconnecting');
      if (openedAt !== null && Date.now() - openedAt >= 10_000) this.delay = 1000;
      this.timer = setTimeout(() => this.connect(), this.delay);
      this.delay = Math.min(this.delay * 2, 30_000);
    });
  }
}
