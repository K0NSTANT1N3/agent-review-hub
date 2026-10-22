import { createConnection, createServer, type Socket } from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { NodeConfig } from '@quorum/protocol';
import type { NodeJournal } from './journal.js';
import type { CommandRunner } from './runner/command-runner.js';

export function controlPath(dataDir: string): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\quorum-${createHash('sha256').update(dataDir).digest('hex').slice(0, 32)}`
    : join(homedir(), '.quorum', 'control', `${createHash('sha256').update(dataDir).digest('hex').slice(0, 24)}.sock`);
}

/** Never reachable over TCP. Native IDs only cross this owner-authenticated local connection. */
export async function startLocalControl(config: NodeConfig, journal: Pick<NodeJournal, 'getSession' | 'lastSessionCommand'>, runner: Pick<CommandRunner, 'attach'>) {
  const path = controlPath(config.dataDir);
  if (process.platform !== 'win32') {
    const dir = dirname(path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const stat = await lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new Error('Unsafe local control directory.');
    await chmod(dir, 0o700);
    // Never unlink another live daemon's socket, but do clear one a crashed Node left behind.
    const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing !== undefined) {
      if (!existing.isSocket() || existing.uid !== process.getuid?.()) throw new Error('Unsafe local control socket path.');
      if (await socketAnswers(path)) throw new Error('Local control socket is in use. Another Node with this data directory is running.');
      await unlink(path);
    }
  }
  const sockets = new Set<Socket>();
  const cleanups = new Set<Promise<void>>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    let lease: Awaited<ReturnType<CommandRunner['attach']>> | undefined;
    let sequence = Promise.resolve();
    let authenticated = false;
    let checked: { sid: string; cancelId?: string } | undefined;
    const authTimer = setTimeout(() => { if (!authenticated) socket.destroy(); }, 5000);
    socket.on('close', () => {
      clearTimeout(authTimer);
      sockets.delete(socket);
      const cleanup = sequence.then(async () => { await lease?.release(true).catch(() => undefined); });
      cleanups.add(cleanup);
      void cleanup.finally(() => cleanups.delete(cleanup));
    });
    socket.on('error', () => undefined);
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 8192) { socket.destroy(); return; }
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        sequence = sequence.then(async () => {
          try {
            const request = JSON.parse(line) as Record<string, unknown>;
            const actual = createHash('sha256').update(typeof request.token === 'string' ? request.token : '').digest();
            const expected = createHash('sha256').update(config.token).digest();
            if (!timingSafeEqual(actual, expected)) throw new Error('Local Node authentication refused. Use the Node token, not an API token.');
            authenticated = true;
            clearTimeout(authTimer);
            if (request.agentId !== config.agentId || origin(request.leaderUrl) !== origin(config.leaderUrl)) throw new Error('Remote session: selected session does not belong to this local Node and Leader.');
            if (request.action === 'release') {
              if (!lease) throw new Error('No attach lease.');
              const current = lease;
              lease = undefined;
              await current.release();
              socket.write(JSON.stringify({ ok: true }) + '\n');
              return;
            }
            if (typeof request.sid !== 'string') throw new Error('Missing session.');
            const session = journal.getSession(request.sid);
            if (!session) throw new Error('Remote session: session is not present on this Node.');
            const adapter = config.adapter;
            const type = adapter.type;
            // Only adapters with a known interactive resume command.
            if (type !== 'claude-code' && type !== 'codex' && type !== 'pi' && type !== 'omp') throw new Error(`Adapter ${type} does not support native resume.`);
            // A reviewer or directive session must stay read-only; an interactive agent can write.
            if (session.profile !== 'author') throw new Error('Only author sessions can be attached; reviewer and directive sessions stay read-only.');
            if (request.action === 'check') {
              checked = { sid: session.sid, cancelId: journal.lastSessionCommand(session.sid, 'task.cancel')?.msgId };
              socket.write(JSON.stringify({ ok: true }) + '\n');
              return;
            }
            if (request.action !== 'acquire' || lease) throw new Error('Invalid attach request.');
            if (checked?.sid !== session.sid || typeof request.taskId !== 'number') throw new Error('Check the selected task session before acquiring.');
            const expectsCancel = ['AUTHORING', 'SYNCING'].includes(String(request.pausedFromState));
            if (expectsCancel) {
              const deadline = Date.now() + 35 * 60_000;
              for (;;) {
                if (socket.destroyed || Date.now() > deadline) throw new Error('Attach cancelled while waiting for pause cleanup.');
                const cancel = journal.lastSessionCommand(session.sid, 'task.cancel');
                if (cancel && cancel.msgId !== checked.cancelId && cancel.state === 'done') break;
                await new Promise((resolve) => setTimeout(resolve, 25));
              }
            }
            lease = await runner.attach(session.sid, request.taskId);
            const ready = journal.getSession(session.sid)!;
            if (!ready.nativeId) {
              await lease.release();
              lease = undefined;
              throw new Error('Session has no native ID yet; wait for its first turn.');
            }
            const binary = adapter.type === 'claude-code' ? 'claude' : adapter.binaryPath ?? type;
            const argv = type === 'codex' ? ['resume', ready.nativeId]
              : type === 'pi' ? ['--session-id', ready.nativeId] : ['--resume', ready.nativeId];
            socket.write(JSON.stringify({ ok: true, command: { adapter: type, binary, argv, cwd: ready.worktree,
              ...(type === 'codex' ? { codexHome: join(config.dataDir, 'codex-home') } : {}) } }) + '\n');
          } catch (error) {
            socket.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Local control failed.' }) + '\n');
          }
        });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => { server.removeListener('error', reject); resolve(); });
  });
  try {
    if (process.platform !== 'win32') await chmod(path, 0o600);
  } catch (error) {
    server.close();
    throw error;
  }
  return { close: async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all([...cleanups]);
    if (process.platform !== 'win32') await unlink(path).catch(() => undefined);
  } };
}

/** True when a live server accepts connections at `path`; a refused or missing socket is stale. */
function socketAnswers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createConnection(path);
    const done = (live: boolean) => { probe.destroy(); resolve(live); };
    probe.once('connect', () => done(true));
    probe.once('error', () => done(false));
    probe.setTimeout(1000, () => done(false));
  });
}

function origin(value: unknown): string {
  if (typeof value !== 'string') return '';
  return new URL(value.replace(/^ws/, 'http')).origin;
}
