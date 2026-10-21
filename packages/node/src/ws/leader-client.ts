import WebSocket from 'ws';
import {
  PROTOCOL_VERSION,
  NodeToLeaderFrameSchema,
  ownerSettingsFromNodeConfig,
  parseLeaderToNodeFrame,
  type Command,
  type DetectedAgent,
  type Event,
  type NodeConfig,
  type NodeStatus,
  type NodeToLeaderFrame,
  type OwnerSettings,
  type RejectReason,
  type WelcomeFrame,
  type TranscriptBatch,
} from '@quorum/protocol';
import type { NodeJournal } from '../journal.js';
import { adapterTrust } from '../detect.js';

const NODE_VERSION = '0.1.0';
const MAX_BACKOFF_MS = 30_000;
const ASSUMED_IDLE_SECONDS = Number.MAX_SAFE_INTEGER;

export interface LeaderClientOptions {
  config: NodeConfig;
  journal: NodeJournal;
  onCommand: (msgId: string, command: Command) => void | Promise<void>;
  getSettings?: () => OwnerSettings;
  idleSeconds?: () => number | null;
  assumeIdle?: boolean;
  insecure?: boolean;
  getRateLimitedUntil?: () => number | null;
  detectedAgents?: readonly DetectedAgent[];
  onWelcome?: (welcome: WelcomeFrame) => void;
  onReject?: (reason: RejectReason) => void;
  onError?: (error: Error) => void;
  random?: () => number;
}

/** Reliable Node-side peer for the Leader's /ws/node endpoint. */
export class LeaderClient {
  readonly url: string;
  private socket: WebSocket | null = null;
  private started = false;
  private stopped = false;
  private terminal = false;
  private welcomed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private resendTimer: ReturnType<typeof setInterval> | null = null;
  private welcomeFrame: WelcomeFrame | null = null;
  private transcriptTimer: ReturnType<typeof setImmediate> | null = null;
  private transcriptRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private transcriptCursor = 0;

  constructor(private readonly options: LeaderClientOptions) {
    this.url = normalizeLeaderUrl(options.config.leaderUrl);
  }

  get welcome(): WelcomeFrame | null {
    return this.welcomeFrame;
  }

  get isConnected(): boolean {
    return this.welcomed && this.socket?.readyState === WebSocket.OPEN;
  }

  get supportsTranscripts(): boolean {
    return !this.stopped && !this.terminal && this.welcomeFrame?.capabilities?.includes('transcript-v1') === true;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    this.clearTimers();
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.welcomed = false;
    if (socket === null || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 1000);
      socket.once('close', () => {
        clearTimeout(timeout);
        resolve();
      });
      if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
      else socket.close(1000, 'node stopping');
    });
  }

  /** Journal the event before attempting delivery; it remains queued until acked. */
  enqueueEvent(event: Event): string {
    const msgId = this.options.journal.enqueueEvent(event);
    this.flushEvents();
    return msgId;
  }

  enqueueTranscript(batch: TranscriptBatch): string | null {
    if (!this.supportsTranscripts) return null;
    const msgId = this.options.journal.enqueueTranscript(batch);
    this.scheduleTranscripts();
    return msgId;
  }

  private connect(): void {
    if (this.stopped || this.terminal) return;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch (error) {
      this.reportError(error);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.on('open', () => {
      if (this.socket !== socket || this.stopped) return;
      this.sendFrame({
        kind: 'hello',
        agentId: this.options.config.agentId,
        token: this.options.config.token,
        nodeVersion: NODE_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        settings: this.settings(),
        sessions: this.sessionReports(),
        adapterType: this.options.config.adapter.type,
        trust: adapterTrust(this.options.config.adapter.type),
        detectedAgents: [...this.options.detectedAgents ?? []],
      });
    });
    socket.on('message', (data) => this.handleMessage(socket, data.toString()));
    socket.on('error', (error) => this.reportError(error));
    socket.on('close', (code) => {
      if (this.socket !== socket) return;
      const hadWelcome = this.welcomed;
      this.socket = null;
      this.welcomed = false;
      this.clearTimers();
      // An older Leader's closed adapterType enum rejects hello with 1008 before welcome.
      if (code === 1008 && !hadWelcome && !this.stopped && !this.terminal) {
        this.terminal = true;
        this.stopped = true;
        this.started = false;
        const adapterType = this.options.config.adapter.type;
        this.reportError(new Error(
          `Leader closed with 1008 before welcome; adapter type "${adapterType}" is not recognized. Upgrade the Leader to a version that supports this adapter.`,
        ));
        return;
      }
      this.scheduleReconnect();
    });
  }

  private handleMessage(socket: WebSocket, raw: string): void {
    const parsed = parseLeaderToNodeFrame(raw);
    if (!parsed.ok) {
      this.reportError(new Error(`Invalid Leader frame: ${parsed.error}`));
      return;
    }
    const frame = parsed.frame;
    switch (frame.kind) {
      case 'welcome':
        this.welcomed = true;
        this.reconnectAttempt = 0;
        this.welcomeFrame = frame;
        if (!frame.capabilities?.includes('transcript-v1')) this.options.journal.discardTranscripts();
        this.transcriptCursor = 0;
        this.startTimers(frame);
        this.options.onWelcome?.(frame);
        this.sendHeartbeat();
        this.flushOutbox();
        return;
      case 'reject':
        this.terminal = true;
        this.options.onReject?.(frame.reason);
        this.stopped = true;
        this.started = false;
        this.clearTimers();
        socket.close(1008, `leader rejected node: ${frame.reason}`);
        return;
      case 'ack':
        this.options.journal.markAcked(frame.msgId);
        return;
      case 'cmd':
        this.receiveCommand(frame.msgId, frame.cmd);
        return;
    }
  }

  private receiveCommand(msgId: string, command: Command): void {
    let inserted: boolean;
    try {
      inserted = this.options.journal.recordCommand(msgId, command);
    } catch (error) {
      this.reportError(error);
      return;
    }
    this.sendFrame({ kind: 'ack', msgId });
    if (!inserted) return;
    try {
      Promise.resolve(this.options.onCommand(msgId, command)).catch((error: unknown) => this.reportError(error));
    } catch (error) {
      this.reportError(error);
    }
  }

  private startTimers(welcome: WelcomeFrame): void {
    this.clearTimers();
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), welcome.heartbeatIntervalSec * 1000);
    this.resendTimer = setInterval(() => this.flushOutbox(), welcome.resendUnackedSec * 1000);
  }

  private sendHeartbeat(): void {
    if (!this.isConnected) return;
    const humanIdleSec = this.options.idleSeconds !== undefined
      ? this.options.idleSeconds()
      : this.options.assumeIdle === true ? ASSUMED_IDLE_SECONDS : null;
    const status: NodeStatus = {
      settings: this.settings(),
      humanIdleSec,
      rateLimitedUntil: this.options.getRateLimitedUntil?.() ?? null,
      sessions: this.sessionReports(),
      trust: adapterTrust(this.options.config.adapter.type),
      detectedAgents: [...this.options.detectedAgents ?? []],
    };
    this.sendFrame({ kind: 'heartbeat', status });
  }

  private sessionReports(): NodeStatus['sessions'] {
    return this.options.journal.listSessions().map((session) => ({
      sid: session.sid,
      alive: session.state !== 'closed' && session.state !== 'lost',
      busy: session.state === 'busy',
      contextTokens: session.contextTokens,
    }));
  }

  private settings(): OwnerSettings {
    return this.options.getSettings?.() ?? ownerSettingsFromNodeConfig(this.options.config);
  }

  private flushOutbox(): void {
    this.flushEvents();
    this.transcriptCursor = 0;
    this.scheduleTranscripts();
  }

  private flushEvents(): void {
    if (!this.isConnected) return;
    for (const event of this.options.journal.unackedEvents()) {
      this.sendFrame({ kind: 'evt', msgId: event.msgId, evt: event.evt });
    }
  }

  private scheduleTranscripts(): void {
    if (!this.isConnected || !this.supportsTranscripts || this.transcriptTimer !== null || this.transcriptRetryTimer !== null) return;
    this.transcriptTimer = setImmediate(() => {
      this.transcriptTimer = null;
      if (!this.isConnected || !this.supportsTranscripts) return;
      // Leave room for task events; send at most one transcript per event-loop turn.
      if ((this.socket?.bufferedAmount ?? 0) > 65536) {
        this.transcriptRetryTimer = setTimeout(() => {
          this.transcriptRetryTimer = null;
          this.scheduleTranscripts();
        }, 25);
        return;
      }
      const record = this.options.journal.nextTranscript(this.transcriptCursor);
      if (record === null) return;
      this.transcriptCursor = record.rowid;
      this.options.journal.markTranscriptSent(record.msgId);
      this.sendFrame({ kind: 'transcript', msgId: record.msgId, ...record.batch });
      this.scheduleTranscripts();
    });
  }

  private sendFrame(frame: NodeToLeaderFrame): void {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return;
    const parsed = NodeToLeaderFrameSchema.safeParse(frame);
    if (!parsed.success) {
      this.reportError(new Error(`Invalid Node frame: ${parsed.error.message}`));
      return;
    }
    socket.send(JSON.stringify(parsed.data));
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.terminal || this.reconnectTimer !== null) return;
    const base = Math.min(1000 * (2 ** this.reconnectAttempt), MAX_BACKOFF_MS);
    this.reconnectAttempt += 1;
    const random = this.options.random?.() ?? Math.random();
    const delay = Math.min(MAX_BACKOFF_MS, Math.round(base * (0.5 + random)));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearTimers(): void {
    if (this.transcriptTimer !== null) clearImmediate(this.transcriptTimer);
    this.transcriptTimer = null;
    if (this.transcriptRetryTimer !== null) clearTimeout(this.transcriptRetryTimer);
    this.transcriptRetryTimer = null;
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    if (this.resendTimer !== null) clearInterval(this.resendTimer);
    this.heartbeatTimer = null;
    this.resendTimer = null;
  }

  private reportError(error: unknown): void {
    this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}

function normalizeLeaderUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`Leader URL must use ws:// or wss://: ${value}`);
  }
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/ws/node';
  if (url.pathname !== '/ws/node') throw new Error(`Leader URL path must be /ws/node: ${value}`);
  return url.toString();
}
