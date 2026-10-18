import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import Fastify, { type FastifyInstance } from 'fastify';
import WebSocket, { WebSocketServer } from 'ws';
import {
  parseNodeToLeaderFrame, PROTOCOL_VERSION, type CmdFrame, type Event, type LeaderConfig,
  type NodeToLeaderFrame, type OwnerSettings, type SessionReport,
} from '@quorum/protocol';
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
  logger?: Logger;
}

type SocketHandler = (socket: WebSocket, request: IncomingMessage) => void;
interface Connection { socket: WebSocket; ready: boolean }

export class NodeHub {
  readonly server: FastifyInstance;
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  private readonly connections = new Map<string, Connection>();
  private readonly settings = new Map<string, OwnerSettings>();
  private readonly routes = new Map<string, SocketHandler>();
  private readonly helloTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly now: () => number;
  private resendTimer: ReturnType<typeof setInterval> | undefined;
  private closing = false;
  private readonly log: Logger;
  private readonly eventFailures = new Map<string, number>();

  constructor(private readonly db: LeaderDb, readonly config: LeaderConfig, private readonly options: HubOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.logger ?? silentLogger;
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
            this.reconcile(frame.agentId, frame.sessions);
          });
          socket.send(JSON.stringify({
            kind: 'welcome', serverTime: this.now(),
            heartbeatIntervalSec: this.config.timeouts.heartbeatIntervalSec,
            resendUnackedSec: this.config.timeouts.resendUnackedSec,
            turnTimeoutSec: this.config.timeouts.turnTimeoutSec, mainBranch: this.config.repo.mainBranch,
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
        this.db.agents.update(agentId, { human_idle_sec: frame.status.humanIdleSec, rate_limited_until: frame.status.rateLimitedUntil });
        this.reconcile(agentId, frame.status.sessions);
        this.db.afterCommit(() => this.options.onStatusChanged?.());
      });
    } else if (frame.kind === 'evt') {
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

  private recordInbound(agentId: string, frame: Extract<NodeToLeaderFrame, { kind: 'evt' }>): void {
    this.db.messages.insert({
      id: frame.msgId, direction: 'from_node', agent_id: agentId, session_id: frame.evt.sid,
      task_id: 'taskId' in frame.evt ? frame.evt.taskId ?? null : null,
      directive_id: 'directiveId' in frame.evt ? frame.evt.directiveId ?? null : null,
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
