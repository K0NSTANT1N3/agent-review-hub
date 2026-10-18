import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { parseLeaderToNodeFrame, PROTOCOL_VERSION, type CmdFrame, type Event, type HelloFrame, type LeaderToNodeFrame, type NodeStatus, type NodeToLeaderFrame, type OwnerSettings } from '@quorum/protocol';

export const DEFAULT_OWNER_SETTINGS: OwnerSettings = {
  maxSessions: 2, lendMode: 'when_idle', lendTokensPerDay: 2_000_000,
  paused: false, tags: [], supportedProfiles: ['author', 'reviewer', 'directive'], contextWindow: 200_000, idleThresholdSec: 300,
};

export interface FakeNodeOptions {
  autoAck?: boolean;
  onCommand?: (frame: CmdFrame, node: FakeNode) => void | Promise<void>;
}

type Kind = LeaderToNodeFrame['kind'];
type Of<K extends Kind> = Extract<LeaderToNodeFrame, { kind: K }>;
interface Waiter {
  matches: (frame: LeaderToNodeFrame) => boolean;
  resolve: (frame: LeaderToNodeFrame) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A scriptable protocol peer; acknowledgements are explicit unless autoAck is enabled. */
export class FakeNode {
  readonly socket: WebSocket;
  readonly frames: LeaderToNodeFrame[] = [];
  readonly errors: unknown[] = [];
  private readonly unread: LeaderToNodeFrame[] = [];
  private readonly waiters: Waiter[] = [];
  private closeCode: number | undefined;
  private readonly closed: Promise<number>;
  private readonly opened: Promise<void>;

  private constructor(url: string, readonly options: FakeNodeOptions) {
    this.socket = new WebSocket(`${url.replace(/\/$/, '')}/ws/node`);
    this.opened = new Promise<void>((resolve, reject) => {
      this.socket.once('open', () => { resolve(); });
      this.socket.once('error', reject);
    });
    this.closed = new Promise<number>((resolve) => {
      this.socket.once('close', (code) => {
        this.closeCode = code;
        for (const waiter of this.waiters.splice(0)) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error(`Socket closed (${code})`));
        }
        resolve(code);
      });
    });
    this.socket.on('error', (error) => { this.errors.push(error); });
    this.socket.on('message', (raw) => {
      const parsed = parseLeaderToNodeFrame(raw.toString());
      if (!parsed.ok) { this.errors.push(new Error(parsed.error)); return; }
      const frame = parsed.frame;
      this.frames.push(frame);
      const index = this.waiters.findIndex((waiter) => waiter.matches(frame));
      const waiter = index < 0 ? undefined : this.waiters.splice(index, 1)[0];
      if (waiter === undefined) this.unread.push(frame);
      else { clearTimeout(waiter.timer); waiter.resolve(frame); }
      if (frame.kind === 'cmd') {
        if (options.autoAck) this.ack(frame.msgId);
        if (options.onCommand !== undefined) {
          try { Promise.resolve(options.onCommand(frame, this)).catch((error: unknown) => { this.errors.push(error); }); }
          catch (error) { this.errors.push(error); }
        }
      }
    });
  }

  static async connect(url: string, hello?: HelloFrame, options: FakeNodeOptions = {}): Promise<FakeNode> {
    const node = new FakeNode(url, options);
    await node.opened;
    if (hello !== undefined) node.send(hello);
    return node;
  }

  static hello(agentId: string, token: string, patch: Partial<HelloFrame> = {}): HelloFrame {
    return { kind: 'hello', agentId, token, nodeVersion: '0.1.0', protocolVersion: PROTOCOL_VERSION, settings: { ...DEFAULT_OWNER_SETTINGS }, sessions: [], adapterType: 'mock', ...patch };
  }

  send(frame: NodeToLeaderFrame): void { this.socket.send(JSON.stringify(frame)); }
  sendRaw(text: string): void { this.socket.send(text); }
  ack(msgId: string): void { this.send({ kind: 'ack', msgId }); }
  event(evt: Event, msgId: string = randomUUID()): string { this.send({ kind: 'evt', msgId, evt }); return msgId; }
  heartbeat(status: NodeStatus): void { this.send({ kind: 'heartbeat', status }); }

  next<K extends Kind>(kind: K, predicate: (frame: Of<K>) => boolean = () => true, timeoutMs = 2_000): Promise<Of<K>> {
    const matches = (frame: LeaderToNodeFrame) => frame.kind === kind && predicate(frame as Of<K>);
    const index = this.unread.findIndex(matches);
    if (index >= 0) return Promise.resolve(this.unread.splice(index, 1)[0] as Of<K>);
    if (this.closeCode !== undefined) return Promise.reject(new Error(`Socket closed (${this.closeCode})`));
    return new Promise<Of<K>>((resolve, reject) => {
      const waiter: Waiter = {
        matches,
        resolve: (frame) => { resolve(frame as Of<K>); },
        reject,
        timer: setTimeout(() => {
          const pending = this.waiters.indexOf(waiter);
          if (pending >= 0) this.waiters.splice(pending, 1);
          reject(new Error(`Timed out waiting for ${kind}`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  async waitClosed(): Promise<number> { return this.closeCode ?? this.closed; }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    if (this.socket.readyState === WebSocket.CONNECTING) this.socket.terminate();
    else if (this.socket.readyState === WebSocket.OPEN) this.socket.close();
    await this.closed;
  }
}
