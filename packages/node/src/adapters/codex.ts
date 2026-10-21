import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AdapterConfig } from '@quorum/protocol';
import { runCliProcess, type SpawnFn } from './cli-process.js';
import { sanitizeFailureMessage, splitText, truncateUtf8 } from './event-utils.js';
import { AdapterError, type AgentAdapter, type AgentEventInput } from './types.js';

type CodexConfig = Extract<AdapterConfig, { type: 'codex' }>;

/**
 * Gives Quorum turns a Codex home that holds only the owner's login. The owner's config.toml (approval
 * reviewers, sandbox overrides, MCP servers), AGENTS.md, skills, hooks and rules must not reach a turn:
 * an approval reviewer can lift the read-only sandbox, and personal instructions make the agent read
 * files outside the worktree into a transcript the whole team sees.
 */
export function prepareCodexHome(homeDir: string, sourceHome: string = process.env.CODEX_HOME || join(homedir(), '.codex')): void {
  if (resolve(sourceHome) === resolve(homeDir)) throw new AdapterError('ADAPTER_ERROR', 'the Quorum Codex home must differ from the owner\'s CODEX_HOME');
  const auth = join(sourceHome, 'auth.json');
  if (!existsSync(auth)) throw new AdapterError('ADAPTER_ERROR', `Codex is not logged in (no auth.json in ${sourceHome}); run \`codex login\``);
  mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  const link = join(homeDir, 'auth.json');
  const stat = lstatSync(link, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink() && readlinkSync(link) === auth) return;
  if (stat !== undefined) rmSync(link, { force: true });
  try {
    // A link keeps token refreshes shared with the owner's own Codex.
    symlinkSync(auth, link);
  } catch {
    copyFileSync(auth, link);
  }
}

/** Reads Codex's "try again at 5:02 AM" into the next matching local time. */
export function parseResetAt(detail: string, now: number = Date.now()): number | undefined {
  const match = /try again at (\d{1,2}):(\d{2})\s*([AP]M)?/i.exec(detail);
  if (match === null) return undefined;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3]?.toUpperCase();
  if (hour > 23 || minute > 59 || (meridiem !== undefined && (hour < 1 || hour > 12))) return undefined;
  if (meridiem === 'PM' && hour !== 12) hour += 12;
  if (meridiem === 'AM' && hour === 12) hour = 0;
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  if (at.getTime() <= now) at.setDate(at.getDate() + 1);
  return at.getTime();
}

export function createCodexAdapter(config: CodexConfig, options: { spawnFn?: SpawnFn; homeDir?: string } = {}): AgentAdapter {
  const contextEstimates = new Map<string, number>();
  return {
    createSession: async () => ({ nativeId: null }),
    runTurn: async ({ nativeId, cwd, profile, prompt, signal, timeoutMs, onEvent }) => {
      const turnId = randomUUID();
      const sandbox = profile === 'author' ? 'workspace-write' : 'read-only';
      const sourceHome = process.env.CODEX_HOME || join(homedir(), '.codex');
      if (options.homeDir !== undefined) prepareCodexHome(options.homeDir, sourceHome);
      const secrets = authSecrets(join(sourceHome, 'auth.json'));
      const emit = (event: AgentEventInput): void => { onEvent?.(redactEvent(event, secrets)); };
      const isolation = ['--ignore-user-config', '--ignore-rules'];
      // exec resume has no -s or -C flags. Its config override reasserts the sandbox on every turn.
      const argv = nativeId === null
        ? ['exec', '--json', '-s', sandbox, ...isolation, '--skip-git-repo-check', '-C', cwd]
        : ['exec', 'resume', nativeId, '--json', '-c', `sandbox_mode="${sandbox}"`, ...isolation, '--skip-git-repo-check'];
      if (config.model !== undefined) argv.push('-m', config.model);
      argv.push('--', prompt);
      let id = nativeId;
      let text = '';
      let agentText = '';
      let completed = false;
      let receivedMessage = false;
      let turnError = '';
      let observedChars = prompt.length;
      let usage = { inputTokens: 0, outputTokens: 0 };
      const result = await runCliProcess({
        binary: config.binaryPath ?? 'codex', argv, cwd, signal, timeoutMs, spawnFn: options.spawnFn,
        ...(options.homeDir === undefined ? {} : { env: { ...process.env, CODEX_HOME: options.homeDir } }),
        onJson: (value) => {
          const event = record(value);
          const item = record(event.item);
          if (event.type === 'thread.started' && typeof event.thread_id === 'string') id = event.thread_id;
          if (event.type === 'error' || event.type === 'turn.failed') {
            turnError = typeof event.message === 'string' ? event.message : JSON.stringify(event.error ?? event);
          }
          if (event.type === 'turn.completed') {
            completed = true;
            const counters = record(event.usage);
            usage = { inputTokens: tokens(counters.input_tokens) ?? 0, outputTokens: tokens(counters.output_tokens) ?? 0 };
            if (tokens(counters.input_tokens) !== undefined || tokens(counters.output_tokens) !== undefined) {
              emit({ kind: 'usage', inputTokens: tokens(counters.input_tokens), outputTokens: tokens(counters.output_tokens) });
            }
          }
          if (typeof item.id !== 'string') return;
          const itemId = `${turnId}:${item.id}`.slice(0, 256);
          if (event.type === 'item.completed' && item.type === 'agent_message' && typeof item.text === 'string') {
            receivedMessage = true;
            text = item.text;
            agentText += item.text;
            observedChars += item.text.length;
            for (const chunk of splitText(text)) emit({ kind: 'text', mode: 'final', text: chunk, messageId: itemId });
          }
          if (item.type !== 'command_execution' && item.type !== 'file_change') return;
          const changes = Array.isArray(item.changes) ? item.changes.map(record) : [];
          if (event.type === 'item.started') {
            const paths = changes.map((change) => change.path).filter((path): path is string => typeof path === 'string' && path.length > 0)
              .slice(0, 20).map((path) => path.slice(0, 1024));
            const summary = item.type === 'command_execution'
              ? (typeof item.command === 'string' ? item.command : '')
              : changes.map((change) => `${change.kind}: ${change.path}`).join(', ');
            emit({
              kind: 'tool_call', id: itemId, name: item.type, toolKind: item.type === 'file_change' ? 'edit' : 'bash',
              argsSummary: summary.slice(0, 256), ...(paths.length === 0 ? {} : { paths }),
            });
          }
          if (event.type === 'item.completed') {
            const output = item.type === 'command_execution' && typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
            observedChars += output.length;
            const exitCode = typeof item.exit_code === 'number' && Number.isInteger(item.exit_code) ? item.exit_code : undefined;
            emit({
              kind: 'tool_result', id: itemId, ok: item.status === 'completed' && (exitCode === undefined || exitCode === 0),
              ...(exitCode === undefined ? {} : { exitCode }), output: truncateUtf8(output),
            });
          }
        },
      });
      const detail = redactSecrets([turnError, result.stderr, agentText].filter(Boolean).join('\n'), secrets);
      if (/rate limit|usage limit|429/i.test(detail)) {
        const resetAt = parseResetAt(detail);
        throw new AdapterError('RATE_LIMITED', sanitizeFailureMessage(detail), resetAt === undefined ? {} : { resetAt });
      }
      if (!completed || !receivedMessage || id === null || id.length === 0 || turnError !== '') {
        throw new AdapterError('ADAPTER_ERROR', sanitizeFailureMessage(`Codex turn did not complete (exit ${result.code}, signal ${result.signal}). ${detail}\n${redactSecrets(result.malformedLines.join('\n'), secrets)}`));
      }
      // Codex exposes cumulative turn input, not context size. Estimate visible retained history
      // at four characters/token; hidden prompts, reasoning and native compaction are unmeasured.
      const contextTokens = (contextEstimates.get(id) ?? 0) + Math.ceil(observedChars / 4);
      contextEstimates.set(id, contextTokens);
      return { nativeId: id, text, usage, contextTokens };
    },
    closeSession: async (nativeId) => { contextEstimates.delete(nativeId); },
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** String values of length ≥ 16 from the owner's auth.json. Never log these. */
function authSecrets(authPath: string): string[] {
  try {
    const secrets: string[] = [];
    collectStringSecrets(JSON.parse(readFileSync(authPath, 'utf8')), secrets);
    secrets.sort((a, b) => b.length - a.length);
    return secrets;
  } catch {
    return [];
  }
}

function collectStringSecrets(value: unknown, into: string[]): void {
  if (typeof value === 'string') {
    if (value.length >= 16) into.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringSecrets(item, into);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectStringSecrets(item, into);
  }
}

function redactSecrets(value: string, secrets: readonly string[]): string {
  let text = value;
  for (const secret of secrets) text = text.split(secret).join('[redacted]');
  return text;
}

function redactEvent(event: AgentEventInput, secrets: readonly string[]): AgentEventInput {
  if (secrets.length === 0) return event;
  const redact = (value: unknown): unknown => typeof value === 'string' ? redactSecrets(value, secrets)
    : Array.isArray(value) ? value.map(redact) : value;
  return Object.fromEntries(Object.entries(event).map(([key, value]) => [key, redact(value)])) as AgentEventInput;
}

function tokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
