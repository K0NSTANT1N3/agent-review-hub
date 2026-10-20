import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiStream } from '../src/ws-stream.js';
import { agentView } from './fixtures.js';

class FakeSocket extends EventEmitter {
  terminate = vi.fn(() => { this.emit('close', 1006, Buffer.from('')); });
  closeWith(code = 1006, reason = '') { this.emit('close', code, Buffer.from(reason)); }
}
afterEach(() => vi.useRealTimers());
function harness(url = 'https://leader.test') {
  const sockets: FakeSocket[] = [];
  const onEvent = vi.fn();
  const onConnection = vi.fn();
  const onAuthError = vi.fn();
  const factory = vi.fn((_url: URL, _token: string) => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  const stream = new UiStream(url, 'secret', { onEvent, onConnection, onAuthError }, factory);
  stream.start();
  return { stream, sockets, factory, onEvent, onConnection, onAuthError };
}

describe('UI stream', () => {
  it('uses the desktop WebSocket URL and token, parses events and ignores bad frames', () => {
    const h = harness();
    expect(String(h.factory.mock.calls[0]?.[0])).toBe('wss://leader.test/ws/ui');
    expect(h.factory.mock.calls[0]?.[1]).toBe('secret');
    const socket = h.sockets[0]!;
    socket.emit('open');
    socket.emit('message', Buffer.from('invalid JSON'));
    socket.emit('message', Buffer.from('{"type":"unknown"}'));
    socket.emit('error', new Error('ignored transport error'));
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'agent.updated', data: agentView() })));
    expect(h.onEvent).toHaveBeenCalledTimes(1);
    expect(h.onConnection.mock.calls.map(([state]) => state)).toEqual(['connecting', 'connected']);
    h.stream.start();
    expect(h.factory).toHaveBeenCalledTimes(1);
    h.stream.stop();
    expect(socket.terminate).toHaveBeenCalled();
  });

  it('backs off 1/2/4/8/16/30 seconds, including short-lived opens', () => {
    vi.useFakeTimers();
    const h = harness('http://leader.test');
    expect(String(h.factory.mock.calls[0]?.[0])).toBe('ws://leader.test/ws/ui');
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      h.sockets.at(-1)!.emit('open');
      h.sockets.at(-1)!.closeWith();
      const count = h.sockets.length;
      vi.advanceTimersByTime(delay - 1);
      expect(h.sockets).toHaveLength(count);
      vi.advanceTimersByTime(1);
      expect(h.sockets).toHaveLength(count + 1);
    }
    h.stream.stop();
    vi.advanceTimersByTime(60000);
    expect(h.sockets).toHaveLength(8);
  });

  it('resets backoff after data or a stable 10 second connection', () => {
    vi.useFakeTimers();
    const h = harness();
    h.sockets[0]!.closeWith();
    vi.advanceTimersByTime(1000);
    h.sockets[1]!.emit('message', Buffer.from('{}'));
    h.sockets[1]!.closeWith();
    vi.advanceTimersByTime(1000);
    expect(h.sockets).toHaveLength(3);
    h.sockets[2]!.emit('open');
    vi.advanceTimersByTime(10000);
    h.sockets[2]!.closeWith();
    vi.advanceTimersByTime(1000);
    expect(h.sockets).toHaveLength(4);
    h.stream.stop();
  });

  it('stops reconnecting after token rejection, and cancels pending retries on stop', () => {
    vi.useFakeTimers();
    const h = harness();
    h.sockets[0]!.closeWith(1008, 'revoked');
    vi.advanceTimersByTime(60000);
    expect(h.factory).toHaveBeenCalledTimes(1);
    expect(h.onAuthError).toHaveBeenCalledWith('revoked');
    expect(h.onConnection).toHaveBeenLastCalledWith('auth-error');
    h.stream.stop();
    h.stream.start();
    h.sockets[1]!.closeWith();
    h.stream.stop();
    vi.advanceTimersByTime(60000);
    expect(h.sockets).toHaveLength(2);
  });

  it('ignores delayed events from a stopped socket after restarting', () => {
    vi.useFakeTimers();
    const h = harness();
    const old = h.sockets[0]!;
    h.stream.stop();
    h.stream.start();
    old.emit('open');
    old.emit('message', Buffer.from(JSON.stringify({ type: 'agent.updated', data: agentView() })));
    old.closeWith();
    vi.advanceTimersByTime(60000);
    expect(h.sockets).toHaveLength(2);
    expect(h.onEvent).not.toHaveBeenCalled();
    h.stream.stop();
  });
});
