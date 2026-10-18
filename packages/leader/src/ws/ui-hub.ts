import type { IncomingMessage } from 'node:http';
import type WebSocket from 'ws';
import type { LeaderConfig, UiEvent } from '@quorum/protocol';
import { authenticate } from '../api/routes.js';
import { agentView, directiveView, taskEventView, taskView, teamActivity } from '../api/views.js';
import type { LeaderDb } from '../db/repo.js';

// /ws/ui?token=… — pushes change notifications (spec §17). Polls the DB for changes only while clients are connected.

const POLL_MS = 500;

export class UiHub {
  private readonly clients = new Set<WebSocket>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private taskWatermark = 0;
  private eventWatermark = 0;
  private readonly agentHashes = new Map<string, string>();
  private readonly directiveHashes = new Map<string, string>();
  private activityHash = '';

  constructor(
    private readonly db: LeaderDb,
    private readonly config: LeaderConfig,
    private readonly now: () => number = Date.now,
  ) {}

  /** WebSocket route handler for NodeHub.registerWebSocket('/ws/ui', …). */
  accept = (socket: WebSocket, request: IncomingMessage): void => {
    const token = new URL(request.url ?? '/', 'http://localhost').searchParams.get('token') ?? undefined;
    if (authenticate(this.db, token) === null) {
      socket.close(1008, 'invalid token');
      return;
    }
    if (this.clients.size === 0) this.resetWatermarks();
    this.clients.add(socket);
    socket.on('close', () => this.clients.delete(socket));
    socket.on('error', () => this.clients.delete(socket));
  };

  start(): void {
    this.resetWatermarks();
    this.timer = setInterval(() => this.poll(), POLL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    for (const c of this.clients) c.terminate();
    this.clients.clear();
  }

  attention = (taskId: number, reason: 'no_reviewer' | 'author_unavailable' | 'escalated', message: string): void => {
    this.broadcast({ type: 'task.needs_attention', data: { taskId, reason, message } });
  };

  private resetWatermarks(): void {
    this.taskWatermark = this.now();
    this.eventWatermark = Math.max(0, ...this.db.taskEvents.all().map((e) => e.id));
    for (const a of this.db.agents.all()) this.agentHashes.set(a.id, JSON.stringify(a));
    for (const d of this.db.directives.all()) this.directiveHashes.set(d.id, JSON.stringify(d));
    this.activityHash = JSON.stringify(teamActivity(this.db, this.now()));
  }

  private poll(): void {
    if (this.clients.size === 0) return;
    try {
      const since = this.taskWatermark;
      this.taskWatermark = this.now();
      for (const t of this.db.tasks.all()) if (t.updated_at >= since) this.broadcast({ type: 'task.updated', data: taskView(this.db, t) });
      for (const e of this.db.taskEvents.all()) {
        if (e.id <= this.eventWatermark) continue;
        this.eventWatermark = e.id;
        this.broadcast({ type: 'task.event', data: taskEventView(e) });
      }
      for (const a of this.db.agents.all()) {
        const hash = JSON.stringify(a);
        if (this.agentHashes.get(a.id) === hash) continue;
        this.agentHashes.set(a.id, hash);
        this.broadcast({ type: 'agent.updated', data: agentView(this.db, a, this.now(), this.config.dayBoundaryTz) });
      }
      for (const d of this.db.directives.all()) {
        const hash = JSON.stringify(d);
        if (this.directiveHashes.get(d.id) === hash) continue;
        this.directiveHashes.set(d.id, hash);
        this.broadcast({ type: 'directive.updated', data: directiveView(d) });
      }
      const activities = teamActivity(this.db, this.now());
      const activityHash = JSON.stringify(activities);
      if (activityHash !== this.activityHash) {
        this.activityHash = activityHash;
        this.broadcast({ type: 'team.activity.updated', data: { activities } });
      }
    } catch {
      // A transient DB error must not kill the poller; the next tick retries.
    }
  }

  private broadcast(event: UiEvent): void {
    const text = JSON.stringify(event);
    for (const c of this.clients) if (c.readyState === 1) c.send(text);
  }
}
