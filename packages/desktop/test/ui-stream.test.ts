import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { UiStream } from '../src/main/ui-stream.js';

let server: WebSocketServer | null = null;
let stream: UiStream | null = null;

afterEach(async () => {
  stream?.stop();
  stream = null;
  await new Promise<void>((resolve) => (server === null ? resolve() : server.close(() => resolve())));
  server = null;
});

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function listen(onConnection: (close: (code: number, reason: string) => void) => void): Promise<string> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  server = wss;
  wss.on('connection', (socket) => onConnection((code, reason) => socket.close(code, reason)));
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  return `http://127.0.0.1:${(wss.address() as AddressInfo).port}`;
}

describe('UiStream', () => {
  it('treats close 1008 as terminal: reports the auth error and does not reconnect', async () => {
    let connections = 0;
    const base = await listen((close) => {
      connections += 1;
      close(1008, 'invalid token');
    });
    const authErrors: string[] = [];
    const states: boolean[] = [];
    stream = new UiStream(base, 'qrm_revoked', { onEvent: () => {}, onConnection: (up) => states.push(up), onAuthError: (r) => authErrors.push(r) });
    stream.start();
    await tick(2500);
    expect(connections).toBe(1);
    expect(authErrors).toEqual(['invalid token']);
    expect(states.at(-1)).toBe(false);
  });

  it('backs off on repeated closes after open instead of retrying every second', async () => {
    const at: number[] = [];
    const base = await listen((close) => {
      at.push(Date.now());
      close(1011, 'boom');
    });
    stream = new UiStream(base, 'qrm_x', { onEvent: () => {}, onConnection: () => {} });
    stream.start();
    await tick(4500);
    // Connects at 0s, 1s and 3s; when `open` reset the delay it connected every second.
    expect(at.length).toBe(3);
    expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(1900);
  });
});
