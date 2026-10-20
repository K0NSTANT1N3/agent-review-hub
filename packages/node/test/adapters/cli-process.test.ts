import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCliProcess } from '../../src/adapters/cli-process.js';
import { ReplayProcess } from './cli-fixtures.js';

afterEach(() => vi.useRealTimers());

function run(child: ReplayProcess, over: Partial<Parameters<typeof runCliProcess>[0]> = {}) {
  return runCliProcess({
    binary: '/bin/agent', argv: ['--json', '$(literal); text'], cwd: '/repo',
    signal: new AbortController().signal, timeoutMs: 10_000, onJson: () => {},
    spawnFn: () => child, ...over,
  });
}

describe('CLI process', () => {
  it('passes argv without a shell, streams UTF-8 JSONL, strips NULs and retains malformed diagnostics', async () => {
    const child = new ReplayProcess();
    const onJson = vi.fn();
    const spawnFn = vi.fn(() => child);
    const env = { PATH: '/bin', AGENT_KEY: 'test' };
    const result = run(child, { onJson, spawnFn, env });
    const badLines = Array.from({ length: 25 }, (_, index) => `bad-${index}`);
    child.replay(badLines.join('\n') + '\n\0{"text":"' + '界'.repeat(30) + '"}\0\nnull\n{"last":true}');
    expect(await result).toEqual({ code: 0, signal: null, stderr: '', malformedLineCount: 25, malformedLines: badLines.slice(-20) });
    expect(onJson.mock.calls.map(([value]) => value)).toEqual([{ text: '界'.repeat(30) }, null, { last: true }]);
    expect(spawnFn).toHaveBeenCalledWith('/bin/agent', ['--json', '$(literal); text'], { cwd: '/repo', env, stdio: ['ignore', 'pipe', 'pipe'] });
  });

  it('retains only the last 8 KB of stderr at a UTF-8 boundary and returns exit signals', async () => {
    const child = new ReplayProcess();
    const result = run(child);
    child.replay('', '界'.repeat(4_000) + 'end', null, 'SIGINT');
    const output = await result;
    expect(output).toMatchObject({ code: null, signal: 'SIGINT' });
    expect(Buffer.byteLength(output.stderr)).toBeLessThanOrEqual(8_192);
    expect(output.stderr).toBe('界'.repeat(2_729) + 'end');
    expect(output.stderr).not.toContain('\ufffd');
  });

  it('does not spawn for an already aborted or expired turn', async () => {
    const spawnFn = vi.fn();
    const controller = new AbortController();
    controller.abort();
    await expect(run(new ReplayProcess(), { spawnFn, signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(run(new ReplayProcess(), { spawnFn, timeoutMs: 0 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('cancels with SIGTERM, waits for close and clears the SIGKILL timer', async () => {
    vi.useFakeTimers();
    const child = new ReplayProcess();
    child.closeOn = null;
    const controller = new AbortController();
    const result = run(child, { signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ code: 'CANCELLED' });
    controller.abort();
    expect(child.signals).toEqual(['SIGTERM']);
    expect(vi.getTimerCount()).toBe(2);
    child.emit('close', null, 'SIGTERM');
    await rejected;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(child.signals).toEqual(['SIGTERM']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out with SIGTERM then SIGKILL exactly five seconds later', async () => {
    vi.useFakeTimers();
    const child = new ReplayProcess();
    child.closeOn = 'SIGKILL';
    const rejected = expect(run(child, { timeoutMs: 100 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(100);
    expect(child.signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(child.signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the first termination cause if cancellation follows timeout', async () => {
    vi.useFakeTimers();
    const child = new ReplayProcess();
    child.closeOn = null;
    const controller = new AbortController();
    const rejected = expect(run(child, { timeoutMs: 10, signal: controller.signal })).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    child.emit('close', null, 'SIGTERM');
    await rejected;
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('maps synchronous spawn failure and child error events', async () => {
    await expect(run(new ReplayProcess(), { spawnFn: () => { throw new Error('missing binary'); } })).rejects.toMatchObject({ code: 'ADAPTER_ERROR', message: expect.stringContaining('missing binary') });
    const child = new ReplayProcess();
    const rejected = expect(run(child)).rejects.toMatchObject({ code: 'ADAPTER_ERROR', message: expect.stringContaining('ENOENT') });
    child.emit('error', new Error('ENOENT'));
    child.emit('close', -2, null);
    await rejected;
  });

  it('stops the child when the event callback or a stream fails', async () => {
    for (const streamError of [false, true]) {
      const child = new ReplayProcess();
      const rejected = expect(run(child, { onJson: () => { throw new Error('consumer failed'); } })).rejects.toMatchObject({ code: 'ADAPTER_ERROR' });
      if (streamError) child.stdout.emit('error', new Error('pipe failed'));
      else child.stdout.write('{}\n');
      await rejected;
      expect(child.signals).toEqual(['SIGTERM']);
    }
  });
});
