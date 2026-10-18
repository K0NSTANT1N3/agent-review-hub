import { readFileSync } from 'node:fs';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import type { DirectiveView, TaskDetail } from '@quorum/protocol';
import { ClientError, QuorumClient, normalizeLeaderUrl } from './client.js';
import { configPath, resolveConfig, writeConfigFile, type Env } from './config.js';
import { STATE_LABEL, formatAgents, formatDirective, formatSummary, formatTaskLine, summarize, type TaskSummary } from './format.js';

/** Exit codes are part of the CLI's contract: scripts and agents branch on them. */
export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  NEEDS_HUMAN: 3,
  FAILED: 4,
  TIMEOUT: 5,
  AUTH: 6,
} as const;

export const USAGE = `quorum: drive Quorum from a terminal, a script or a coding agent

Usage:
  quorum login --url <leader url> --token <token | ->
  quorum agents
  quorum task create --title <text> [--description <text> | --description-file <path | ->]
                     [--tags a,b] [--priority low|normal|high|urgent] [--mode own|pool] [--require-approval]
                     [--wait] [--timeout <sec>]
  quorum task list [--all] [--state <STATE>]
  quorum task status <id>
  quorum task wait <id> [--timeout <sec>]
  quorum task diff <id> [--from <sha>] [--to <sha>]
  quorum task answer <id> (<text> | --file <path | ->)
  quorum ask <agent id> <question> [--no-wait] [--timeout <sec>]

Global options:
  --json          machine-readable output on stdout
  --url, --token  override QUORUM_URL / QUORUM_TOKEN / the saved login
  -h, --help      show this help

Exit codes:
  0  done (task merged, answer received)
  1  error (Leader unreachable, invalid request)
  2  usage error
  3  a person must act (task needs a decision or an answer, or was paused by a person)
  4  task failed or was cancelled, or the directive failed
  5  timed out while waiting
  6  not logged in, invalid token, or the token may not do this

Tokens: create one in the Quorum app (Settings, Agent CLI access) or with
\`quorum-leader add-token\`. CLI tokens can read, create tasks, answer a blocked
author and ask agents. They can never approve, send back, cancel or merge.`;

export interface Deps {
  env: Env;
  out: (text: string) => void;
  err: (text: string) => void;
  readStdin: () => Promise<string>;
  stdinIsTTY: boolean;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

class UsageError extends Error {}

const GLOBAL_OPTIONS = {
  json: { type: 'boolean' },
  url: { type: 'string' },
  token: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies ParseArgsConfig['options'];

const PRIORITIES: Record<string, number> = { low: 0, normal: 1, high: 2, urgent: 3 };

export async function run(argv: string[], deps: Deps): Promise<number> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  let json = argv.includes('--json');
  try {
    const [cmd, sub] = argv;
    if (cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h') {
      deps.out(USAGE);
      return cmd === undefined ? EXIT.USAGE : EXIT.OK;
    }
    const command = cmd === 'task' ? `task ${sub ?? ''}`.trim() : cmd;
    const rest = argv.slice(cmd === 'task' ? 2 : 1);

    const parse = <O extends NonNullable<ParseArgsConfig['options']>>(options: O) => {
      const parsed = parseArgs({ args: rest, options: { ...GLOBAL_OPTIONS, ...options }, allowPositionals: true, strict: true });
      json = (parsed.values as { json?: boolean }).json === true;
      return parsed;
    };

    const connect = (values: { url?: string | boolean; token?: string | boolean }) => {
      const cfg = resolveConfig({ ...(typeof values.url === 'string' ? { url: values.url } : {}), ...(typeof values.token === 'string' ? { token: values.token } : {}) }, deps.env);
      if (cfg.url === undefined || cfg.token === undefined) {
        throw new ClientError(401, 'NOT_LOGGED_IN', 'not logged in: run `quorum login --url <leader url> --token <token>` or set QUORUM_URL and QUORUM_TOKEN');
      }
      return new QuorumClient(normalizeLeaderUrl(cfg.url), cfg.token, deps.fetch);
    };

    const emit = (data: unknown, human: string) => deps.out(json ? JSON.stringify(data, null, 2) : human);

    const taskId = (positional: string[]): number => {
      const id = Number(positional[0]);
      if (positional[0] === undefined || !Number.isSafeInteger(id) || id <= 0) throw new UsageError('a task id is required');
      return id;
    };

    const seconds = (v: string | boolean | undefined, fallback: number): number => {
      if (typeof v !== 'string') return fallback;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new UsageError(`invalid number of seconds: ${v}`);
      return n;
    };

    const readText = async (path: string): Promise<string> => (path === '-' ? deps.readStdin() : readFileSync(path, 'utf8'));

    /** Polls until the task merges, fails or needs a person, or until `timeoutSec` (0 = no limit). */
    const waitForTask = async (client: QuorumClient, id: number, timeoutSec: number, intervalMs: number): Promise<number> => {
      const deadline = timeoutSec === 0 ? Infinity : now() + timeoutSec * 1000;
      let lastState: string | null = null;
      for (;;) {
        const detail: TaskDetail = await client.call('getTask', { id });
        const s = summarize(detail);
        if (s.state !== lastState && !json) deps.err(`#${id} ${STATE_LABEL[s.state]}`);
        lastState = s.state;
        if (s.outcome !== 'pending') return finish(s);
        if (now() >= deadline) {
          emit({ ...s, timedOut: true }, `${formatSummary(s)}\n  timed out after ${timeoutSec}s; resume with: quorum task wait ${id}`);
          return EXIT.TIMEOUT;
        }
        await sleep(intervalMs);
      }
    };

    const finish = (s: TaskSummary): number => {
      emit(s, formatSummary(s));
      if (s.outcome === 'merged') return EXIT.OK;
      if (s.outcome === 'needs_human') return EXIT.NEEDS_HUMAN;
      if (s.outcome === 'failed') return EXIT.FAILED;
      return EXIT.OK;
    };

    const interval = (deps.env.QUORUM_POLL_MS !== undefined ? Number(deps.env.QUORUM_POLL_MS) : 2000) || 2000;

    switch (command) {
      case 'login': {
        const { values } = parse({});
        if (typeof values.url !== 'string' || typeof values.token !== 'string') throw new UsageError('login needs --url and --token');
        const token = (values.token === '-' ? await deps.readStdin() : values.token).trim();
        const url = normalizeLeaderUrl(values.url);
        await new QuorumClient(url, token, deps.fetch).call('listAgents');
        const path = configPath(deps.env);
        writeConfigFile(path, { url, token });
        emit({ url, configPath: path }, `Logged in to ${url}. Saved to ${path}.`);
        return EXIT.OK;
      }

      case 'agents': {
        const { values } = parse({});
        const { agents } = await connect(values).call('listAgents');
        emit(agents, formatAgents(agents));
        return EXIT.OK;
      }

      case 'task create': {
        const { values } = parse({
          title: { type: 'string' },
          description: { type: 'string' },
          'description-file': { type: 'string' },
          tags: { type: 'string' },
          priority: { type: 'string' },
          mode: { type: 'string' },
          'require-approval': { type: 'boolean' },
          wait: { type: 'boolean' },
          timeout: { type: 'string' },
        });
        if (typeof values.title !== 'string' || values.title.trim() === '') throw new UsageError('--title is required');
        let description = typeof values.description === 'string' ? values.description : undefined;
        if (description === undefined && typeof values['description-file'] === 'string') description = await readText(values['description-file']);
        if (description === undefined && !deps.stdinIsTTY) description = await deps.readStdin();
        if (description === undefined || description.trim() === '') throw new UsageError('a description is required (--description, --description-file or stdin)');
        const priority = typeof values.priority === 'string' ? (PRIORITIES[values.priority] ?? Number(values.priority)) : 1;
        if (!Number.isInteger(priority) || priority < 0 || priority > 3) throw new UsageError('--priority must be low, normal, high or urgent');
        const mode = typeof values.mode === 'string' ? values.mode : 'own';
        if (mode !== 'own' && mode !== 'pool') throw new UsageError('--mode must be own or pool');
        const tags = typeof values.tags === 'string' ? values.tags.split(',').map((t) => t.trim()).filter(Boolean) : [];
        const timeoutSec = seconds(values.timeout, 1800);
        const client = connect(values);
        const task = await client.call('createTask', { body: { title: values.title.trim(), description, tags, priority, mode, requireHumanApproval: values['require-approval'] === true } });
        if (values.wait === true) {
          if (!json) deps.err(`created #${task.id}`);
          return await waitForTask(client, task.id, timeoutSec, interval);
        }
        emit({ id: task.id, state: task.state }, `Created #${task.id}. Follow it with: quorum task wait ${task.id}`);
        return EXIT.OK;
      }

      case 'task list': {
        const { values } = parse({ all: { type: 'boolean' }, state: { type: 'string' } });
        const query: Record<string, string> = { mine: values.all === true ? 'false' : 'true' };
        if (typeof values.state === 'string') query.state = values.state.toUpperCase();
        const { tasks } = await connect(values).call('listTasks', { query });
        emit(
          tasks.map((t) => ({ id: t.id, title: t.title, state: t.state, requester: t.requesterOwner, updatedAt: t.updatedAt })),
          tasks.length === 0 ? 'No tasks.' : tasks.map(formatTaskLine).join('\n'),
        );
        return EXIT.OK;
      }

      case 'task status': {
        const { values, positionals } = parse({});
        const id = taskId(positionals);
        const s = summarize(await connect(values).call('getTask', { id }));
        emit(s, formatSummary(s));
        return EXIT.OK;
      }

      case 'task wait': {
        const { values, positionals } = parse({ timeout: { type: 'string' } });
        const id = taskId(positionals);
        const timeoutSec = seconds(values.timeout, 1800);
        return await waitForTask(connect(values), id, timeoutSec, interval);
      }

      case 'task diff': {
        const { values, positionals } = parse({ from: { type: 'string' }, to: { type: 'string' } });
        const id = taskId(positionals);
        const query: Record<string, string> = {};
        if (typeof values.from === 'string') query.from = values.from;
        if (typeof values.to === 'string') query.to = values.to;
        const diff = await connect(values).call('getTaskDiff', { id, query });
        emit(diff, diff.diff === '' ? '(no changes)' : diff.diff.trimEnd());
        return EXIT.OK;
      }

      case 'task answer': {
        const { values, positionals } = parse({ file: { type: 'string' } });
        const id = taskId(positionals);
        const answer = typeof values.file === 'string' ? await readText(values.file) : positionals.slice(1).join(' ');
        if (answer.trim() === '') throw new UsageError('an answer is required (text or --file)');
        const task = await connect(values).call('answerTask', { id, body: { answer } });
        emit({ id: task.id, state: task.state }, `Answered #${task.id}; its author continues. Follow it with: quorum task wait ${task.id}`);
        return EXIT.OK;
      }

      case 'ask': {
        const { values, positionals } = parse({ 'no-wait': { type: 'boolean' }, timeout: { type: 'string' } });
        const [agentId, ...words] = positionals;
        const text = words.join(' ');
        if (agentId === undefined || text.trim() === '') throw new UsageError('usage: quorum ask <agent id> <question>');
        const timeoutSec = seconds(values.timeout, 600);
        const client = connect(values);
        let d: DirectiveView = await client.call('createDirective', { body: { agentId, text } });
        if (values['no-wait'] === true) {
          emit(d, `Asked ${agentId} (directive ${d.id}).`);
          return EXIT.OK;
        }
        const deadline = timeoutSec === 0 ? Infinity : now() + timeoutSec * 1000;
        while (d.state === 'queued' || d.state === 'running') {
          if (now() >= deadline) {
            emit({ ...d, timedOut: true }, `No answer from ${agentId} after ${timeoutSec}s (directive ${d.id} is ${d.state}).`);
            return EXIT.TIMEOUT;
          }
          await sleep(interval);
          d = await client.call('getDirective', { id: d.id });
        }
        emit(d, formatDirective(d));
        return d.state === 'done' ? EXIT.OK : EXIT.FAILED;
      }

      default:
        throw new UsageError(`unknown command: ${argv.slice(0, cmd === 'task' ? 2 : 1).join(' ')}`);
    }
  } catch (error) {
    return reportError(error, json, deps);
  }
}

function reportError(error: unknown, json: boolean, deps: Deps): number {
  let code: string;
  let message: string;
  let exit: number;
  if (error instanceof UsageError || (error instanceof Error && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS'))) {
    code = 'USAGE';
    message = `${error.message}\nRun \`quorum --help\` for usage.`;
    exit = EXIT.USAGE;
  } else if (error instanceof ClientError) {
    code = error.code;
    message = error.message;
    exit = error.status === 401 || error.status === 403 ? EXIT.AUTH : EXIT.ERROR;
  } else {
    code = 'ERROR';
    message = error instanceof Error ? error.message : String(error);
    exit = EXIT.ERROR;
  }
  if (json) deps.out(JSON.stringify({ error: code, message }, null, 2));
  deps.err(`quorum: ${message}`);
  return exit;
}
