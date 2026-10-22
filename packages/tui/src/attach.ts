import { createConnection, type Socket } from 'node:net';
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { QuorumApi } from './api-client.js';

export interface ResumeCommand { adapter: string; binary: string; argv: string[]; cwd: string; codexHome?: string }
export interface AttachControl {
  check(): Promise<void>;
  acquire(pausedFromState?: string | null): Promise<ResumeCommand>;
  release(): Promise<void>;
  close(): void;
}

/** Deliberately separate from Leader/API credentials. Nothing here is sent to the Leader. */
export function localControl(configPath: string | undefined, leaderUrl: string, agentId: string, sid: string, taskId: number): AttachControl {
  if (!configPath) throw new Error('Local attach requires --node-config <quorum.node.json> (or QUORUM_NODE_CONFIG). Remote sessions cannot attach.');
  if (process.platform !== 'win32' && (statSync(configPath).mode & 0o077) !== 0) throw new Error('Node config must be private: chmod 600 on the Node config.');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as { token?: string; dataDir?: string };
  if (!config.token) throw new Error('Node config has no Node token.');
  const rawDir = config.dataDir ?? '~/.quorum/node';
  const dataDir = resolve(rawDir === '~' ? homedir() : /^~[\\/]/.test(rawDir) ? join(homedir(), rawDir.slice(2)) : rawDir);
  const path = process.platform === 'win32'
    ? `\\\\.\\pipe\\quorum-${createHash('sha256').update(dataDir).digest('hex').slice(0, 32)}`
    : join(homedir(), '.quorum', 'control', `${createHash('sha256').update(dataDir).digest('hex').slice(0, 24)}.sock`);
  let socket: Socket | undefined;
  let buffer = '';
  let pending: { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | undefined;
  function fail(error: Error) {
    if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = undefined; }
  }
  async function request(action: string, pausedFromState?: string | null): Promise<Record<string, unknown>> {
    if (pending) throw new Error('Local control request already pending.');
    if (!socket) {
      socket = createConnection(path);
      socket.setEncoding('utf8');
      socket.on('error', () => fail(new Error('Cannot reach local Node control endpoint. Start the local Node; remote sessions cannot attach.')));
      socket.on('close', () => fail(new Error('Local Node control connection closed.')));
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 65536) { fail(new Error('Invalid local control response.')); socket?.destroy(); return; }
        const index = buffer.indexOf('\n');
        if (index < 0) return;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          const response = JSON.parse(line) as Record<string, unknown>;
          if (pending) {
            const current = pending;
            pending = undefined;
            clearTimeout(current.timer);
            if (response.ok !== true) current.reject(new Error(String(response.error ?? 'Local control refused attach.')));
            else current.resolve(response);
          }
        } catch { fail(new Error('Invalid local control response.')); }
      });
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { fail(new Error('Timed out waiting for local session to become idle.')); socket?.destroy(); }, action === 'acquire' ? 35 * 60_000 : 125_000);
      pending = { resolve, reject, timer };
      socket!.write(JSON.stringify({ action, token: config.token, leaderUrl, agentId, sid, taskId, pausedFromState }) + '\n');
    });
  }
  return {
    check: async () => { await request('check'); },
    acquire: async (pausedFromState) => {
      const { command } = await request('acquire', pausedFromState);
      if (!isResumeCommand(command)) throw new Error('Invalid native resume command from local Node.');
      return command;
    },
    release: async () => { await request('release'); },
    close: () => { socket?.destroy(); },
  };
}

function isResumeCommand(value: unknown): value is ResumeCommand {
  if (!value || typeof value !== 'object') return false;
  const command = value as Record<string, unknown>;
  return ['claude-code', 'codex', 'pi', 'omp'].includes(String(command.adapter)) && typeof command.binary === 'string'
    && Array.isArray(command.argv) && command.argv.every((arg) => typeof arg === 'string') && typeof command.cwd === 'string'
    && (command.codexHome === undefined || typeof command.codexHome === 'string');
}

/** pause acknowledgement, local drain/lock, terminal handoff, guard, resume, transcript reload. */
export async function attachTask(client: QuorumApi, taskId: number, control: AttachControl, terminal: {
  run(command: ResumeCommand): Promise<void>;
  reload(): Promise<void>;
}): Promise<void> {
  let paused = false;
  let acquired = false;
  let pausedFromState: string | null = null;
  const errors: string[] = [];
  try {
    await control.check();
    try { pausedFromState = (await client.call('pauseTask', { id: taskId })).pausedFromState; }
    catch (error) { throw new Error(`Attach pause refused: ${message(error)}`); }
    paused = true;
    const command = await control.acquire(pausedFromState);
    acquired = true;
    await terminal.run(command);
  } catch (error) { errors.push(message(error)); }
  finally {
    if (acquired) {
      try { await control.release(); } catch (error) { errors.push(message(error)); }
    }
    control.close();
    if (paused) {
      try { await client.call('resumeTask', { id: taskId }); }
      catch (error) { errors.push(`Could not resume task #${taskId}: ${message(error)}. Use p to resume.`); }
      try { await terminal.reload(); } catch (error) { errors.push(message(error)); }
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
}

export function spawnResume(command: ResumeCommand, spawnFn: typeof spawn = spawn): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnFn(command.binary, command.argv, { cwd: command.cwd, stdio: 'inherit', shell: false,
      env: { ...agentEnv(process.env), ...(command.codexHome ? { CODEX_HOME: command.codexHome } : {}) } });
    const ignoreInterrupt = () => undefined;
    process.on('SIGINT', ignoreInterrupt);
    child.once('close', () => process.removeListener('SIGINT', ignoreInterrupt));
    child.once('error', (error: NodeJS.ErrnoException) => reject(new Error(error.code === 'ENOENT'
      ? `Missing agent binary: ${command.binary}. Install it or fix the Node adapter binaryPath.` : message(error))));
    // close, not exit: the agent has released the terminal only once its stdio closes.
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Native ${command.adapter} exited with ${signal ?? code}.`));
    });
  });
}

/** The agent gets the owner's shell environment minus Quorum's own credentials (Node config path, API token). */
export function agentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('QUORUM_')));
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
