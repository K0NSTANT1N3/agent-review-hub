import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import {
  parseNodeToLeaderFrame,
  type LeaderToNodeFrame,
  type NodeToLeaderFrame,
} from '@quorum/protocol';

type FrameKind = NodeToLeaderFrame['kind'];
type FrameOf<K extends FrameKind> = Extract<NodeToLeaderFrame, { kind: K }>;

interface Waiter {
  matches: (frame: NodeToLeaderFrame) => boolean;
  resolve: (frame: NodeToLeaderFrame) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A scriptable WebSocket peer for Node client and daemon tests. */
export class FakeLeaderConnection {
  readonly frames: NodeToLeaderFrame[] = [];
  readonly errors: Error[] = [];
  private readonly unread: NodeToLeaderFrame[] = [];
  private readonly waiters: Waiter[] = [];

  constructor(readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const parsed = parseNodeToLeaderFrame(data.toString());
      if (!parsed.ok) {
        this.errors.push(new Error(parsed.error));
        return;
      }
      const frame = parsed.frame;
      this.frames.push(frame);
      const index = this.waiters.findIndex((waiter) => waiter.matches(frame));
      const waiter = index < 0 ? undefined : this.waiters.splice(index, 1)[0];
      if (waiter === undefined) this.unread.push(frame);
      else {
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      }
    });
    socket.on('error', (error) => this.errors.push(error));
    socket.on('close', () => {
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('Fake Leader connection closed'));
      }
    });
  }

  send(frame: LeaderToNodeFrame): void {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('Fake Leader socket is not open');
    this.socket.send(JSON.stringify(frame));
  }

  next<K extends FrameKind>(
    kind: K,
    predicate: (frame: FrameOf<K>) => boolean = () => true,
    timeoutMs = 2_000,
  ): Promise<FrameOf<K>> {
    const matches = (frame: NodeToLeaderFrame): frame is FrameOf<K> => frame.kind === kind && predicate(frame as FrameOf<K>);
    const index = this.unread.findIndex(matches);
    if (index >= 0) return Promise.resolve(this.unread.splice(index, 1)[0] as FrameOf<K>);
    return new Promise<FrameOf<K>>((resolve, reject) => {
      const waiter: Waiter = {
        matches,
        resolve: (frame) => resolve(frame as FrameOf<K>),
        reject,
        timer: setTimeout(() => {
          const pending = this.waiters.indexOf(waiter);
          if (pending >= 0) this.waiters.splice(pending, 1);
          reject(new Error(`Timed out waiting for Node frame ${kind}`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }
}

export class FakeLeader {
  readonly connections: FakeLeaderConnection[] = [];
  private server: Server | null = null;
  private webSocketServer: WebSocketServer | null = null;
  private port: number | null = null;

  get url(): string {
    if (this.port === null) throw new Error('Fake Leader has not started');
    return `ws://127.0.0.1:${this.port}/ws/node`;
  }

  async start(): Promise<void> {
    if (this.server !== null) return;
    const server = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    const webSocketServer = new WebSocketServer({ noServer: true });
    server.on('upgrade', (request, socket, head) => {
      if (request.url !== '/ws/node') {
        socket.destroy();
        return;
      }
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit('connection', webSocket, request);
      });
    });
    webSocketServer.on('connection', (socket) => this.connections.push(new FakeLeaderConnection(socket)));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port ?? 0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        this.port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
    this.server = server;
    this.webSocketServer = webSocketServer;
  }

  async waitForConnection(count = 1, timeoutMs = 3_000): Promise<FakeLeaderConnection> {
    const deadline = Date.now() + timeoutMs;
    while (this.connections.length < count) {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for Fake Leader connection ${count}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return this.connections[count - 1]!;
  }

  async restart(): Promise<void> {
    const port = this.port;
    await this.stop();
    this.port = port;
    await this.start();
  }

  async stop(): Promise<void> {
    const server = this.server;
    const webSocketServer = this.webSocketServer;
    this.server = null;
    this.webSocketServer = null;
    if (server === null || webSocketServer === null) return;
    for (const client of webSocketServer.clients) client.terminate();
    await Promise.all([
      new Promise<void>((resolve) => webSocketServer.close(() => resolve())),
      new Promise<void>((resolve) => {
        if (!server.listening) resolve();
        else server.close(() => resolve());
      }),
    ]);
  }
}

export function welcomeFrame(patch: Partial<Extract<LeaderToNodeFrame, { kind: 'welcome' }>> = {}) {
  return {
    kind: 'welcome' as const,
    serverTime: Date.now(),
    heartbeatIntervalSec: 60,
    resendUnackedSec: 60,
    turnTimeoutSec: 1800,
    mainBranch: 'main',
    ...patch,
  };
}
