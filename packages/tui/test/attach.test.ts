import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentEnv, attachTask, localControl, spawnResume, type AttachControl, type ResumeCommand } from '../src/attach.js';
import { handoffTerminal } from '../src/terminal.js';
import type { QuorumApi } from '../src/api-client.js';

const command: ResumeCommand = { adapter: 'codex', binary: 'codex', argv: ['resume', 'private-native-id'], cwd: '/worktree', codexHome: '/node/codex-home' };
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(disposers.splice(0).map((dispose) => dispose())); });

function harness(failAt?: string) {
  const order: string[] = [];
  const step = async (name: string) => { order.push(name); if (name === failAt) throw new Error(`${name} refused`); };
  const client = { call: async (route: string) => { await step(route); return {}; } } as QuorumApi;
  const control: AttachControl = {
    check: () => step('check'), acquire: async () => { await step('idle'); return command; },
    release: () => step('guard'), close: () => { order.push('close'); },
  };
  const terminal = {
    run: (resume: ResumeCommand) => handoffTerminal({ suspend: () => { order.push('unmount'); }, restore: () => order.push('remount') }, async () => {
      expect(resume).toEqual(command);
      await step('spawn');
    }), reload: () => step('transcript'),
  };
  return { order, client, control, terminal };
}

describe('native attach lifecycle', () => {
  it('pauses, waits for idle, hands over terminal, guards, resumes, then reloads', async () => {
    const h = harness();
    await attachTask(h.client, 12, h.control, h.terminal);
    expect(h.order).toEqual(['check', 'pauseTask', 'idle', 'unmount', 'spawn', 'remount', 'guard', 'close', 'resumeTask', 'transcript']);
  });

  it.each(['spawn', 'guard', 'idle', 'resumeTask'])('recovers after %s error and still reloads', async (stage) => {
    const h = harness(stage);
    await expect(attachTask(h.client, 12, h.control, h.terminal)).rejects.toThrow(`${stage} refused`);
    expect(h.order.at(-1)).toBe('transcript');
    expect(h.order).toContain('resumeTask');
    if (stage === 'spawn') expect(h.order).toEqual(['check', 'pauseTask', 'idle', 'unmount', 'spawn', 'remount', 'guard', 'close', 'resumeTask', 'transcript']);
  });

  it('never acquires or resumes when pause is refused', async () => {
    const h = harness('pauseTask');
    await expect(attachTask(h.client, 12, h.control, h.terminal)).rejects.toThrow('Attach pause refused');
    expect(h.order).toEqual(['check', 'pauseTask', 'close']);
  });

  it('rejects remote/unsupported preflight before pausing', async () => {
    const h = harness('check');
    await expect(attachTask(h.client, 12, h.control, h.terminal)).rejects.toThrow('check refused');
    expect(h.order).toEqual(['check', 'close']);
  });

  it('uses inherited stdio, exact native ID and Codex home with a fake spawner', async () => {
    const child = new EventEmitter();
    const spawner = vi.fn(() => { queueMicrotask(() => { child.emit('exit', 0, null); child.emit('close', 0, null); }); return child; });
    await spawnResume(command, spawner as unknown as typeof spawn);
    expect(spawner).toHaveBeenCalledWith('codex', ['resume', 'private-native-id'], expect.objectContaining({
      cwd: '/worktree', stdio: 'inherit', shell: false, env: expect.objectContaining({ CODEX_HOME: '/node/codex-home' }),
    }));
  });

  it('explains a missing binary and restores terminal after spawn error', async () => {
    const child = new EventEmitter();
    const spawner = vi.fn(() => { queueMicrotask(() => { child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })); child.emit('close'); }); return child; });
    const restore = vi.fn();
    await expect(handoffTerminal({ suspend: vi.fn(), restore }, () => spawnResume(command, spawner as unknown as typeof spawn))).rejects.toThrow('Missing agent binary: codex');
    expect(restore).toHaveBeenCalledOnce();
  });

  it.skipIf(process.platform === 'win32')('uses a fake authenticated local endpoint; never passes native ID to Leader', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qt-'));
    const controlDir = join(homedir(), '.quorum', 'control');
    await mkdir(controlDir, { recursive: true, mode: 0o700 });
    const socketPath = join(controlDir, `${createHash('sha256').update(dir).digest('hex').slice(0, 24)}.sock`);
    const config = join(dir, 'node.json');
    await writeFile(config, JSON.stringify({ dataDir: dir, token: 'node-secret' }), { mode: 0o600 });
    const requests: Record<string, unknown>[] = [];
    const server = createServer((socket) => {
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        const index = buffer.indexOf('\n');
        if (index < 0) return;
        const request = JSON.parse(buffer.slice(0, index)) as Record<string, unknown>;
        buffer = buffer.slice(index + 1);
        requests.push(request);
        socket.write(JSON.stringify({ ok: true, ...(request.action === 'acquire' ? { command } : {}) }) + '\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    disposers.push(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
    const h = harness();
    const control = localControl(config, 'https://leader.test', 'local-agent', 'sid', 12);
    await attachTask(h.client, 12, control, h.terminal);
    expect(requests.map((request) => request.action)).toEqual(['check', 'acquire', 'release']);
    expect(requests.every((request) => request.token === 'node-secret')).toBe(true);
    expect(h.order).toEqual(['pauseTask', 'unmount', 'spawn', 'remount', 'resumeTask', 'transcript']);
  });

  it('strips Quorum credentials from the agent environment', async () => {
    const env = agentEnv({ PATH: '/bin', HOME: '/home/u', TERM: 'xterm', QUORUM_TOKEN: 'qrq_owner', QUORUM_NODE_CONFIG: '/home/u/quorum.node.json', QUORUM_URL: 'http://l' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/home/u', TERM: 'xterm' });
  });
});
