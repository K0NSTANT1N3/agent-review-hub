import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import WebSocket, { WebSocketServer } from 'ws';
import {
  parseNodeToLeaderFrame, ProfileSchema, PROTOCOL_VERSION, type CmdFrame, type Event,
  type NodeToLeaderFrame, type NodeStatus, type OwnerSettings, type SessionProfile, type SessionReport,
  type TranscriptAppended, type TranscriptFrame,
} from '@quorum/protocol';
import { LeaderRuntimeConfigSchema, type LeaderConfigWithRetention } from '../config.js';
import type { LeaderDb, SessionRow } from '../db/repo.js';
import type { LockManager } from '../core/locks.js';
import { silentLogger, type Logger } from '../logging.js';

/** Deterministically failing events are recorded and acked after this many attempts. */
export const POISON_EVENT_ATTEMPTS = 5;

export interface HubOptions {
  locks: LockManager;
  now?: () => number;
  onEvent?: (agentId: string, event: Event) => void;
  onSessionLost?: (session: SessionRow, reason: string) => void;
  onStatusChanged?: () => void;
  onTranscript?: (batch: TranscriptAppended) => void;
  logger?: Logger;
}

type SocketHandler = (socket: WebSocket, request: IncomingMessage) => void;
interface Connection { socket: WebSocket; ready: boolean }
interface PendingTranscript {
  agentId: string;
  socket: WebSocket;
  frame: TranscriptFrame;
  profile?: SessionProfile;
  turnId: string;
}

export class NodeHub {
  readonly server: FastifyInstance;
  // A valid 100-event transcript can exceed 1 MiB, including UTF-8 text and path summaries.
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  private readonly connections = new Map<string, Connection>();
  private readonly settings = new Map<string, OwnerSettings>();
  private readonly routes = new Map<string, SocketHandler>();
  private readonly helloTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly now: () => number;
  private resendTimer: ReturnType<typeof setInterval> | undefined;
  private closing = false;
  private readonly log: Logger;
  private readonly eventFailures = new Map<string, number>();
  private readonly transcripts: PendingTranscript[] = [];
  private readonly transcriptRetries = new Map<string, { msgId: string; seq: number }>();
  private transcriptImmediate: ReturnType<typeof setImmediate> | undefined;
  private readonly transcriptMaxBytes: number;

  constructor(private readonly db: LeaderDb, readonly config: LeaderConfigWithRetention, private readonly options: HubOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.logger ?? silentLogger;
    this.transcriptMaxBytes = LeaderRuntimeConfigSchema.shape.transcriptMaxBytesPerTask.parse(config.transcriptMaxBytesPerTask);
    const { certFile, keyFile } = config.tls;
    if ((certFile === null) !== (keyFile === null)) throw new Error('TLS requires both certificate and key');
    this.server = Fastify({
      logger: false,
      ...(certFile !== null && keyFile !== null ? { https: { cert: readFileSync(certFile), key: readFileSync(keyFile) } } : {}),
    });
    this.registerWebSocket('/ws/node', (socket) => this.accept(socket));
    this.server.server.on('upgrade', (request, socket, head) => {
      let path: string;
      try { path = new URL(request.url ?? '/', 'http://localhost').pathname; }
      catch { socket.destroy(); return; }
      const handler = this.routes.get(path);
      if (handler === undefined || this.closing) { socket.destroy(); return; }
      this.sockets.handleUpgrade(request, socket, head, (ws) => handler(ws, request));
    });
  }

  registerWebSocket(path: string, handler: SocketHandler): void {
    if (this.routes.has(path)) throw new Error(`Duplicate WebSocket route: ${path}`);
    this.routes.set(path, handler);
  }

  async start(): Promise<{ port: number; url: string }> {
    await this.server.listen(this.config.listen);
    const address = this.server.server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected TCP listener');
    this.resendTimer = setInterval(() => this.resendUnacked(), this.config.timeouts.resendUnackedSec * 1000);
    this.resendTimer.unref();
    const host = this.config.listen.host.includes(':') ? `[${this.config.listen.host}]` : this.config.listen.host;
    return { port: address.port, url: `${this.config.tls.certFile === null ? 'ws' : 'wss'}://${host}:${address.port}` };
  }

  ownerSettings(agentId: string): OwnerSettings | undefined { return this.settings.get(agentId); }

  deliver(agentId: string, frame: CmdFrame): void {
    const connection = this.connections.get(agentId);
    if (connection?.ready !== true || connection.socket.readyState !== WebSocket.OPEN) return;
    if (this.db.agents.get(agentId)?.revoked !== 0) return;
    const row = this.db.messages.get(frame.msgId);
    if (row === undefined || row.direction !== 'to_node' || row.agent_id !== agentId || row.acked_at !== null) return;
    connection.socket.send(JSON.stringify(frame));
    this.db.messages.update(row.id, { sent_at: row.sent_at ?? this.now() });
  }

  resendUnacked(agentId?: string): void {
    for (const row of this.db.unackedMessages(agentId)) {
      // Payloads were validated before outbox insertion.
      const frame = JSON.parse(row.payload) as CmdFrame;
      this.deliver(row.agent_id, frame);
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    if (this.transcriptImmediate !== undefined) clearImmediate(this.transcriptImmediate);
    this.transcripts.length = 0;
    this.transcriptRetries.clear();
    if (this.resendTimer !== undefined) clearInterval(this.resendTimer);
    for (const timer of this.helloTimers) clearTimeout(timer);
    this.helloTimers.clear();
    for (const socket of this.sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => this.sockets.close(() => resolve()));
    await this.server.close();
  }

  private accept(socket: WebSocket): void {
    let agentId: string | undefined;
    const connection: Connection = { socket, ready: false };
    const timer = setTimeout(() => socket.close(1008, 'hello required'), 10_000);
    timer.unref();
    this.helloTimers.add(timer);
    const clearHelloTimer = () => { clearTimeout(timer); this.helloTimers.delete(timer); };
    socket.on('error', () => { /* close handler reconciles connectivity; outbox remains durable */ });
    socket.on('message', (raw, binary) => {
      if (binary) { socket.close(1008, 'JSON text required'); return; }
      const parsed = parseNodeToLeaderFrame(raw.toString());
      if (!parsed.ok) { socket.close(1008, 'invalid frame'); return; }
      const frame = parsed.frame;
      try {
        if (agentId === undefined) {
          if (frame.kind !== 'hello') { socket.close(1008, 'hello required'); return; }
          const agent = this.db.agents.get(frame.agentId);
          const hash = createHash('sha256').update(frame.token).digest();
          const expected = Buffer.from(agent?.token_hash ?? '', 'hex');
          const reject = agent === undefined || expected.length !== hash.length || !timingSafeEqual(expected, hash)
            ? 'bad_token' : agent.revoked !== 0 ? 'revoked' : frame.protocolVersion !== PROTOCOL_VERSION ? 'version_mismatch' : null;
          if (reject !== null) { socket.send(JSON.stringify({ kind: 'reject', reason: reject })); socket.close(1008); clearHelloTimer(); return; }
          const old = this.connections.get(frame.agentId);
          old?.socket.send(JSON.stringify({ kind: 'reject', reason: 'already_connected' }));
          old?.socket.close(1008);
          agentId = frame.agentId;
          this.connections.set(agentId, connection);
          clearHelloTimer();
          this.db.withTx(() => {
            this.storeSettings(frame.agentId, frame.settings);
            this.storeMetadata(frame.agentId, frame);
            this.reconcile(frame.agentId, frame.sessions);
          });
          socket.send(JSON.stringify({
            kind: 'welcome', serverTime: this.now(),
            heartbeatIntervalSec: this.config.timeouts.heartbeatIntervalSec,
            resendUnackedSec: this.config.timeouts.resendUnackedSec,
            turnTimeoutSec: this.config.timeouts.turnTimeoutSec, mainBranch: this.config.repo.mainBranch,
            capabilities: ['transcript-v1'],
          }));
          connection.ready = true;
          this.resendUnacked(agentId);
          this.options.onStatusChanged?.();
          return;
        }
        if (this.connections.get(agentId) !== connection) return;
        this.receive(agentId, socket, frame);
      } catch (error) {
        // No ACK is sent when the event transaction fails, allowing a safe retry.
        this.log.error({ err: error, agentId, kind: frame.kind, msgId: 'msgId' in frame ? frame.msgId : undefined }, 'node frame failed');
        if (!connection.ready) socket.close(1011, 'hello failed');
      }
    });
    socket.on('close', () => {
      clearHelloTimer();
      if (agentId !== undefined && this.connections.get(agentId) === connection) {
        this.connections.delete(agentId);
        this.db.agents.update(agentId, { status: 'offline' });
        this.options.onStatusChanged?.();
      }
    });
  }

  private receive(agentId: string, socket: WebSocket, frame: NodeToLeaderFrame): void {
    if (this.db.agents.get(agentId)?.revoked !== 0) {
      socket.send(JSON.stringify({ kind: 'reject', reason: 'revoked' }));
      socket.close(1008);
      return;
    }
    if (frame.kind === 'hello') { socket.close(1008, 'already authenticated'); return; }
    if (frame.kind === 'ack') {
      const message = this.db.messages.get(frame.msgId);
      if (message?.direction === 'to_node' && message.agent_id === agentId && message.acked_at === null) {
        this.db.messages.update(message.id, { acked_at: this.now() });
      }
    } else if (frame.kind === 'heartbeat') {
      this.db.withTx(() => {
        this.storeSettings(agentId, frame.status.settings);
        this.storeMetadata(agentId, frame.status);
        this.db.agents.update(agentId, { human_idle_sec: frame.status.humanIdleSec, rate_limited_until: frame.status.rateLimitedUntil });
        this.reconcile(agentId, frame.status.sessions);
        this.db.afterCommit(() => this.options.onStatusChanged?.());
      });
    } else if (frame.kind === 'transcript') {
      this.queueTranscript(agentId, socket, frame);
    } else if (frame.kind === 'evt') {
      if (this.db.transcriptReceipts.get(frame.msgId) !== undefined) { socket.close(1008, 'invalid message identity'); return; }
      const existing = this.db.messages.get(frame.msgId);
      if (existing !== undefined) {
        if (existing.direction !== 'from_node' || existing.agent_id !== agentId) { socket.close(1008, 'invalid message identity'); return; }
        socket.send(JSON.stringify({ kind: 'ack', msgId: frame.msgId }));
        return;
      }
      const session = this.db.sessions.get(frame.evt.sid);
      if (session !== undefined && session.agent_id !== agentId) { socket.close(1008, 'session ownership mismatch'); return; }
      if (session === undefined) {
        // Acking (not closing) is essential: the Node would otherwise resend this on every reconnect forever.
        this.recordInbound(agentId, frame);
        this.log.warn({ agentId, msgId: frame.msgId, sid: frame.evt.sid, type: frame.evt.type }, 'stale_event: unknown session');
        socket.send(JSON.stringify({ kind: 'ack', msgId: frame.msgId }));
        return;
      }
      try {
        this.db.withTx(() => {
          this.recordInbound(agentId, frame);
          const result: unknown = this.options.onEvent?.(agentId, frame.evt);
          if (result !== null && typeof result === 'object' && 'then' in result) throw new TypeError('Event handlers must be synchronous');
        });
      } catch (error) {
        const attempts = (this.eventFailures.get(frame.msgId) ?? 0) + 1;
        if (attempts < POISON_EVENT_ATTEMPTS) {
          this.eventFailures.set(frame.msgId, attempts);
          throw error;
        }
        this.eventFailures.delete(frame.msgId);
        this.recordInbound(agentId, frame);
        this.log.error({ err: error, agentId, msgId: frame.msgId, sid: frame.evt.sid, type: frame.evt.type, attempts }, 'poisoned_event: acked without applying');
        socket.send(JSON.stringify({ kind: 'ack', msgId: frame.msgId }));
        return;
      }
      this.eventFailures.delete(frame.msgId);
      socket.send(JSON.stringify({ kind: 'ack', msgId: frame.msgId }));
      this.options.onStatusChanged?.();
    }
  }

  private queueTranscript(agentId: string, socket: WebSocket, frame: TranscriptFrame): void {
    const session = this.db.sessions.get(frame.sid);
    const lastTurn = this.db.latestTurnCommand(frame.sid);
    const lastTask = lastTurn === undefined ? (session === undefined ? undefined : (JSON.parse(session.task_history) as number[]).at(-1)) : lastTurn.task_id;
    const matchesTask = session?.lock_kind === 'task' ? session.lock_ref === String(frame.taskId)
      : session?.lock_kind === null && lastTask === frame.taskId;
    const profile = ProfileSchema.safeParse(session?.profile);
    const valid = session?.agent_id === agentId && matchesTask && profile.success && this.db.tasks.get(frame.taskId) !== undefined;
    if (valid && this.awaitingTranscriptReplay(frame)) return;
    // Bound pending work without letting later seqs overtake an unpersisted batch.
    if (this.transcripts.length >= 32) {
      if (valid) this.retryTranscript(frame);
      return;
    }
    // Capture assignment before a following evt can release/reassign this session.
    this.transcripts.push({ agentId, socket, frame, turnId: lastTurn?.id ?? '', ...(valid && profile.success ? { profile: profile.data } : {}) });
    this.scheduleTranscript();
  }

  private scheduleTranscript(): void {
    if (this.transcriptImmediate !== undefined || this.closing) return;
    this.transcriptImmediate = setImmediate(() => {
      this.transcriptImmediate = undefined;
      const pending = this.transcripts.shift();
      if (pending !== undefined) this.ingestTranscript(pending);
      if (this.transcripts.length > 0) this.scheduleTranscript();
    });
  }

  private ingestTranscript({ agentId, socket, frame, profile, turnId }: PendingTranscript): void {
    try {
      if (this.db.agents.get(agentId)?.revoked !== 0) return;
      if (profile !== undefined && this.awaitingTranscriptReplay(frame)) return;
      const receipt = this.db.transcriptReceipts.get(frame.msgId);
      if (this.db.messages.get(frame.msgId) !== undefined || (receipt !== undefined && receipt.agent_id !== agentId)) {
        socket.close(1008, 'invalid message identity');
        return;
      }
      let batch: TranscriptAppended | undefined;
      if (receipt === undefined) this.db.withTx(() => {
        this.db.transcriptReceipts.insert({ id: frame.msgId, agent_id: agentId });
        if (profile === undefined) {
          this.log.warn({ agentId, msgId: frame.msgId, sid: frame.sid, taskId: frame.taskId }, 'transcript dropped: session assignment mismatch');
          return;
        }
        const events = this.db.appendTranscript(frame.taskId, frame.sid, agentId, profile, frame.events, turnId, this.transcriptMaxBytes);
        if (events.length > 0) batch = { taskId: frame.taskId, sid: frame.sid, agentId, profile, events };
      });
      if (this.transcriptRetries.get(frame.sid)?.msgId === frame.msgId) this.transcriptRetries.delete(frame.sid);
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ kind: 'ack', msgId: frame.msgId }));
      if (batch !== undefined) {
        try { this.options.onTranscript?.(batch); }
        catch (error) { this.log.error({ err: error, agentId, msgId: frame.msgId }, 'transcript notification failed'); }
      }
    } catch (error) {
      // Transcript failures never enter EventHandlers or prevent a subsequent evt from advancing the task.
      if (profile !== undefined) this.retryTranscript(frame);
      this.log.error({ err: error, agentId, msgId: frame.msgId, sid: frame.sid, taskId: frame.taskId }, 'transcript ingest failed; awaiting replay');
    }
  }

  private awaitingTranscriptReplay(frame: TranscriptFrame): boolean {
    const retry = this.transcriptRetries.get(frame.sid);
    return retry !== undefined && frame.msgId !== retry.msgId && frame.events.at(-1)!.seq >= retry.seq;
  }

  private retryTranscript(frame: TranscriptFrame): void {
    const retry = this.transcriptRetries.get(frame.sid);
    if (retry === undefined || frame.events[0]!.seq < retry.seq) this.transcriptRetries.set(frame.sid, { msgId: frame.msgId, seq: frame.events[0]!.seq });
  }

  private storeMetadata(agentId: string, status: Pick<NodeStatus, 'trust' | 'detectedAgents'>): void {
    this.db.agents.update(agentId, { trust: status.trust ?? null, detected_agents: status.detectedAgents === undefined ? null : JSON.stringify(status.detectedAgents) });
  }

  private recordInbound(agentId: string, frame: Extract<NodeToLeaderFrame, { kind: 'evt' }>): void {
    // Session-level events (e.g. session.compacted) carry no task id; attribute them to the task the
    // session is locked to so they appear in that task's transcript.
    const session = this.db.sessions.get(frame.evt.sid);
    const lockedTask = session?.lock_kind === 'task' && session.lock_ref !== null ? Number(session.lock_ref) : null;
    const lockedDirective = session?.lock_kind === 'directive' ? session.lock_ref : null;
    this.db.messages.insert({
      id: frame.msgId, direction: 'from_node', agent_id: agentId, session_id: frame.evt.sid,
      task_id: 'taskId' in frame.evt && frame.evt.taskId !== undefined ? frame.evt.taskId : lockedTask,
      directive_id: 'directiveId' in frame.evt && frame.evt.directiveId !== undefined ? frame.evt.directiveId : lockedDirective,
      conversation_id: 'conversationId' in frame.evt ? frame.evt.conversationId : null,
      type: frame.evt.type, payload: JSON.stringify(frame), created_at: this.now(), acked_at: this.now(),
    });
  }

  private storeSettings(agentId: string, settings: OwnerSettings): void {
    this.db.agents.update(agentId, {
      status: 'online', last_heartbeat_at: this.now(), max_sessions: settings.maxSessions,
      lend_mode: settings.lendMode, lend_tokens_per_day: settings.lendTokensPerDay,
      paused: settings.paused ? 1 : 0, tags: JSON.stringify(settings.tags), context_window: settings.contextWindow,
      human_idle_sec: null,
    });
    this.db.afterCommit(() => { this.settings.set(agentId, settings); });
  }

  private reconcile(agentId: string, reports: SessionReport[]): void {
    const alive = reports.filter((report) => report.alive).map((report) => report.sid);
    this.options.locks.extendLease(agentId, alive);
    for (const report of reports) {
      const session = this.db.sessions.get(report.sid);
      if (session?.agent_id === agentId) this.db.sessions.update(session.id, { context_tokens: report.contextTokens });
    }
    const aliveSet = new Set(alive);
    for (const session of this.db.sessions.find({ agent_id: agentId, state: 'locked' })) {
      if (!aliveSet.has(session.id)) {
        this.options.locks.releaseSession(session.id, 'lost');
        this.options.onSessionLost?.(session, 'heartbeat_missing');
      }
    }
  }
}
