import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AdapterConfig } from '@quorum/protocol';
import { runCliProcess, type SpawnFn } from './cli-process.js';
import { tokenCount } from './custom.js';
import { sanitizeFailureMessage, splitText, toolKindFor, truncateUtf8 } from './event-utils.js';
import { parseResetAt } from './codex.js';
import { AdapterError, type AgentAdapter, type AgentEventInput, type Profile } from './types.js';

type KiloConfig = Extract<AdapterConfig, { type: 'kilo' }>;

export function kiloPermissions(profile: Profile): Record<string, string> {
  return { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', list: 'allow',
    ...(profile === 'author' ? { edit: 'allow', bash: 'allow' } : {}) };
}

/** Only provider login records cross from the owner. No config, skills, MCP, or approval state. */
export function prepareKiloEnvironment(homeDir: string, profile: Profile, cwd: string, owner: NodeJS.ProcessEnv = process.env): {
  env: NodeJS.ProcessEnv; secrets: string[];
} {
  const ownerHome = owner.HOME || homedir();
  const root = resolve(homeDir, profile);
  if (resolve(homeDir) === resolve(ownerHome) || root === resolve(ownerHome)) {
    throw new AdapterError('ADAPTER_ERROR', 'the Quorum Kilo home must differ from the owner home');
  }
  const env = Object.fromEntries(Object.entries(owner).filter(([key]) => !/^(KILO_|OPENCODE_)/.test(key)));
  for (const dir of ['', 'config/kilo', 'data/kilo', 'cache', 'state', 'managed']) {
    mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
  }
  const authPath = join(owner.XDG_DATA_HOME || join(ownerHome, '.local/share'), 'kilo/auth.json');
  const auth: Record<string, unknown> = {};
  if (existsSync(authPath)) {
    let logins: Record<string, unknown>;
    try {
      logins = record(JSON.parse(readFileSync(authPath, 'utf8')));
    } catch {
      // JSON parser diagnostics can contain credential bytes. Never publish them to the team.
      throw new AdapterError('ADAPTER_ERROR', 'Could not read Kilo provider logins; run `kilo auth login`.');
    }
    for (const [provider, credentials] of Object.entries(logins)) {
      const type = record(credentials).type;
      // A wellknown record can load remote config. Only login records belong in this home.
      if (type === 'api' || type === 'oauth') auth[provider] = credentials;
    }
  }
  writeFileSync(join(root, 'data/kilo/auth.json'), JSON.stringify(auth), { mode: 0o600 });
  const secrets: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === 'string' && value.length >= 16) secrets.push(value);
    else if (value !== null && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(auth);
  for (const [key, value] of Object.entries(env)) {
    if (/API_KEY|TOKEN|SECRET|PASSWORD/.test(key) && value !== undefined && value.length >= 16) secrets.push(value);
  }
  const permission = kiloPermissions(profile);
  Object.assign(env, {
    HOME: root, PWD: cwd,
    XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
    KILO_TEST_HOME: root, KILO_CONFIG_DIR: join(root, 'config/kilo'), KILO_TEST_MANAGED_CONFIG_DIR: join(root, 'managed'),
    KILO_DISABLE_PROJECT_CONFIG: 'true', KILO_DISABLE_CLAUDE_CODE: 'true', KILO_DISABLE_EXTERNAL_SKILLS: 'true',
    KILO_DISABLE_DEFAULT_PLUGINS: 'true', KILO_DISABLE_AUTOUPDATE: 'true', KILO_DISABLE_FFF: 'true',
    KILO_PERMISSION: JSON.stringify(permission),
    KILO_CONFIG_CONTENT: JSON.stringify({
      default_agent: 'quorum', agent: { quorum: { mode: 'primary', permission } }, permission,
      instructions: [], plugin: [], mcp: {}, lsp: false, formatter: false, share: 'disabled', autoupdate: false,
    }),
  });
  return { env, secrets: secrets.sort((a, b) => b.length - a.length) };
}

/** Kilo 7.8.15: run JSON reports completed parts, not live tool-start or text-delta events. */
export function createKiloAdapter(config: KiloConfig, options: { homeDir?: string; spawnFn?: SpawnFn } = {}): AgentAdapter {
  const homeDir = options.homeDir ?? join(homedir(), '.quorum/kilo-home');
  return {
    createSession: async () => ({ nativeId: null }),
    runTurn: async ({ nativeId, cwd, profile, prompt, signal, timeoutMs, onEvent }) => {
      const { env, secrets } = prepareKiloEnvironment(homeDir, profile, cwd);
      const redact = (text: string) => secrets.reduce((value, secret) => value.split(secret).join('[redacted]'), text);
      const emit = (event: AgentEventInput) => onEvent?.(event);
      const argv = ['run', '--format', 'json', '--pure', '--agent', 'quorum', '--dir', cwd];
      if (nativeId !== null) argv.push('--session', nativeId);
      if (config.model !== undefined) argv.push('--model', config.model);
      argv.push('--', prompt);
      const turnId = randomUUID();
      const seen = new Set<string>();
      let id = nativeId;
      let text = '';
      let receivedText = false;
      let textMessageId = '';
      let ended = false;
      let failure: unknown;
      let contextTokens = 0;
      const usage = { inputTokens: 0, outputTokens: 0 };
      const result = await runCliProcess({
        binary: config.binaryPath ?? 'kilo', argv, cwd, env, signal, timeoutMs, spawnFn: options.spawnFn,
        onJson: (value) => {
          const event = record(value);
          if (typeof event.sessionID === 'string' && event.sessionID.length > 0) id = event.sessionID;
          if (event.type === 'error') failure = event.error ?? event;
          const part = record(event.part);
          if (typeof part.id !== 'string' || seen.has(part.id)) return;
          seen.add(part.id);
          const messageId = `${turnId}:${string(part.messageID) || part.id}`.slice(0, 256);
          if ((event.type === 'text' || event.type === 'reasoning') && typeof part.text === 'string') {
            if (event.type === 'text') {
              text = textMessageId === messageId ? text + part.text : part.text;
              textMessageId = messageId;
              receivedText = true;
            }
            for (const chunk of splitText(redact(part.text))) {
              emit(event.type === 'text' ? { kind: 'text', mode: 'final', text: chunk, messageId } : { kind: 'thinking', text: chunk, messageId });
            }
          }
          if (event.type === 'tool_use' && typeof part.callID === 'string' && typeof part.tool === 'string') {
            const state = record(part.state);
            const input = record(state.input);
            const callId = `${turnId}:${part.callID}`.slice(0, 256);
            const path = string(input.filePath) || string(input.path);
            const summary = string(input.command) || path || string(input.pattern);
            // The CLI supplies the call and result together after tool completion.
            emit({ kind: 'tool_call', id: callId, name: redact(part.tool).slice(0, 100), toolKind: toolKindFor(part.tool),
              argsSummary: redact(summary).slice(0, 256), ...(path ? { paths: [redact(path).slice(0, 1024)] } : {}) });
            const exitCode = record(state.metadata).exit;
            emit({ kind: 'tool_result', id: callId, ok: state.status === 'completed' && (typeof exitCode !== 'number' || exitCode === 0),
              output: truncateUtf8(redact(string(state.output) || string(state.error))),
              ...(typeof exitCode === 'number' && Number.isSafeInteger(exitCode) ? { exitCode } : {}) });
          }
          if (event.type === 'step_finish') {
            ended = part.reason === 'stop' || part.reason === 'end-turn';
            const counters = record(part.tokens);
            const inputTokens = tokenCount(counters.input);
            const outputTokens = tokenCount(counters.output);
            const total = tokenCount(counters.total);
            usage.inputTokens += inputTokens ?? 0;
            usage.outputTokens += outputTokens ?? 0;
            if (total !== undefined) contextTokens = total;
            if (inputTokens !== undefined || outputTokens !== undefined || total !== undefined) {
              emit({ kind: 'usage', inputTokens, outputTokens, contextTokens: total });
            }
          }
        },
      });
      if (result.code !== 0 || !ended || !receivedText || id === null || failure !== undefined) {
        const detail = redact([failure === undefined ? '' : JSON.stringify(failure), result.stderr, result.malformedLines.join('\n')].join('\n'));
        if (isRateLimited(failure) || /rate[ _-]?limit|usage[ _-]?limit|429/i.test(detail)) {
          throw new AdapterError('RATE_LIMITED', sanitizeFailureMessage(detail), { resetAt: kiloResetAt(failure) ?? parseResetAt(detail) });
        }
        throw new AdapterError('ADAPTER_ERROR', sanitizeFailureMessage(`Kilo turn did not complete (exit ${result.code}, signal ${result.signal}). ${detail}`));
      }
      return { nativeId: id, text: redact(text), usage, contextTokens: contextTokens || Math.ceil((prompt.length + text.length) / 4) };
    },
    closeSession: async () => {},
  };
}

function isRateLimited(value: unknown): boolean {
  const data = record(value);
  return data.statusCode === 429 || data.status === 429 || /rate[ _-]?limit|usage[ _-]?limit|429/i.test(string(data.name) + string(data.message))
    || (data.data !== undefined && isRateLimited(data.data)) || (data.error !== undefined && isRateLimited(data.error));
}

/** Numeric epoch seconds/milliseconds, ISO time, and HTTP retry headers. */
export function kiloResetAt(value: unknown, now = Date.now()): number | undefined {
  const data = record(value);
  const reset = data.resetAt ?? data.resetsAt ?? data.reset_at ?? data.resets_at;
  if (typeof reset === 'number' && Number.isFinite(reset)) return reset < 1e12 ? reset * 1000 : reset;
  if (typeof reset === 'string') {
    const parsed = /^\d+(\.\d+)?$/.test(reset) ? kiloResetAt({ resetAt: Number(reset) }, now) : Date.parse(reset);
    if (parsed !== undefined && Number.isFinite(parsed)) return parsed;
  }
  const headers = record(data.responseHeaders);
  const retry = headers['retry-after'];
  if (typeof retry === 'string') {
    const at = Number.isFinite(Number(retry)) ? now + Number(retry) * 1000 : Date.parse(retry);
    if (Number.isFinite(at)) return at;
  }
  const headerReset = headers['x-ratelimit-reset'] ?? headers['ratelimit-reset'];
  if (typeof headerReset === 'string') return kiloResetAt({ resetAt: headerReset }, now);
  return (data.data === undefined ? undefined : kiloResetAt(data.data, now))
    ?? (data.error === undefined ? undefined : kiloResetAt(data.error, now));
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function string(value: unknown): string { return typeof value === 'string' ? value : ''; }
