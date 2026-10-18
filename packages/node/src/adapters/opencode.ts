import { randomUUID } from 'node:crypto';
import type { AdapterConfig } from '@quorum/protocol';
import { AdapterError, type AgentAdapter, type TurnResult } from './types.js';

type OpencodeConfig = Extract<AdapterConfig, { type: 'opencode' }>;

export interface OpencodeAdapterOptions {
  /** Keep tests fast while preserving the production two-second polling interval. */
  pollIntervalMs?: number;
  /** Injected in tests; defaults to the Node fetch implementation. */
  fetchImpl?: typeof fetch;
}

interface MessageEnvelope {
  info: {
    role?: unknown;
    finish?: unknown;
    error?: unknown;
    tokens?: unknown;
  };
  parts: unknown[];
}

const MAX_POST_RETRIES = 2;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const ABORT_REQUEST_TIMEOUT_MS = 5_000;

/** Talks to an OpenCode server over its documented HTTP API. */
export function createOpencodeAdapter(
  config: OpencodeConfig,
  options: OpencodeAdapterOptions = {},
): AgentAdapter {
  let base: URL;
  try {
    base = new URL(config.baseUrl);
  } catch (error) {
    throw new AdapterError('ADAPTER_ERROR', 'OpenCode baseUrl must be a valid URL.', { cause: error });
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new AdapterError('ADAPTER_ERROR', 'OpenCode baseUrl must use http or https.');
  }
  if (base.search !== '' || base.hash !== '') {
    throw new AdapterError('ADAPTER_ERROR', 'OpenCode baseUrl must not include a query string or fragment.');
  }

  const rootPath = base.pathname.replace(/\/+$/, '');
  const endpoint = (path: string): string => base.origin + rootPath + path;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new AdapterError('ADAPTER_ERROR', 'OpenCode pollIntervalMs must be a non-negative number.');
  }

  return {
    createSession: async ({ cwd }) => {
      const url = new URL(endpoint('/session'));
      // OpenCode binds a session to the requested project directory. This must be the
      // Quorum worktree rather than the server's default directory.
      url.searchParams.set('directory', cwd);
      const response = await request(fetchImpl, url.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
      });
      const payload = await readResponse(response);
      if (!response.ok) throw responseError(response, payload);
      if (!isRecord(payload) || typeof payload.id !== 'string' || payload.id.length === 0) {
        throw new AdapterError('ADAPTER_ERROR', 'OpenCode create-session response did not contain an id.');
      }
      return { nativeId: payload.id };
    },

    runTurn: async ({ nativeId, prompt, signal: callerSignal, timeoutMs }) => {
      if (nativeId === null || nativeId.length === 0) {
        throw new AdapterError('ADAPTER_ERROR', 'OpenCode runTurn requires a native session id.');
      }
      const timeoutController = new AbortController();
      const timeout = setTimeout(() => timeoutController.abort(), Math.max(0, timeoutMs));
      const signal = AbortSignal.any([callerSignal, timeoutController.signal]);
      try {
        const postResponse = await postMessageWithRetries({
          fetchImpl,
          url: endpoint('/session/' + encodeURIComponent(nativeId) + '/message'),
          providerID: config.providerID,
          modelID: config.modelID,
          prompt,
          signal,
        });
        let finalMessage = finalAssistant(postResponse);
        if (finalMessage !== null) throwIfMessageFailed(finalMessage);
        while (finalMessage?.info.finish !== 'stop') {
          throwIfAborted(callerSignal, timeoutController.signal);
          await delay(pollIntervalMs, signal);
          const messages = await getMessages(
            fetchImpl,
            endpoint('/session/' + encodeURIComponent(nativeId) + '/message'),
            signal,
          );
          finalMessage = lastAssistant(messages);
          if (finalMessage !== null) throwIfMessageFailed(finalMessage);
        }
        if (finalMessage === null) {
          throw new AdapterError('ADAPTER_ERROR', 'OpenCode returned no completed assistant message.');
        }

        throwIfMessageFailed(finalMessage);
        const text = finalMessage.parts
          .filter(isRecord)
          .filter((part) => part.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text as string)
          .join('');
        return { nativeId, ...turnUsage(finalMessage, prompt, text) };
      } catch (error) {
        if (callerSignal.aborted || timeoutController.signal.aborted) {
          // Dropping the HTTP request does not stop the OpenCode agent. Ask the server to abort
          // the session so it stops editing the worktree after Quorum reports the turn as ended.
          await abortSession(fetchImpl, endpoint('/session/' + encodeURIComponent(nativeId) + '/abort'));
        }
        if (callerSignal.aborted) {
          throw new AdapterError('CANCELLED', 'OpenCode turn was cancelled.', { cause: error });
        }
        if (timeoutController.signal.aborted) {
          throw new AdapterError('TIMEOUT', 'OpenCode turn timed out.', { cause: error });
        }
        if (error instanceof AdapterError) throw error;
        throw new AdapterError('ADAPTER_ERROR', errorMessage(error), { cause: error });
      } finally {
        clearTimeout(timeout);
      }
    },

    closeSession: async (nativeId) => {
      const response = await request(fetchImpl, endpoint('/session/' + encodeURIComponent(nativeId)), {
        method: 'DELETE',
        signal: AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS),
      });
      const payload = await readResponse(response);
      if (!response.ok && response.status !== 404) throw responseError(response, payload);
    },
  };
}

async function postMessageWithRetries(options: {
  fetchImpl: typeof fetch;
  url: string;
  providerID: string;
  modelID: string;
  prompt: string;
  signal: AbortSignal;
}): Promise<MessageEnvelope | null> {
  // OpenCode accepts caller-provided message IDs. Reusing one makes the bounded
  // retry safe if the server accepted a POST but the connection failed before reply.
  const messageID = 'msg_' + randomUUID().replaceAll('-', '');
  for (let attempt = 0; ; attempt += 1) {
    throwIfSignalAborted(options.signal);
    let response: Response;
    try {
      response = await request(options.fetchImpl, options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messageID,
          model: { providerID: options.providerID, modelID: options.modelID },
          parts: [{ type: 'text', text: options.prompt }],
        }),
        signal: options.signal,
      });
    } catch (error) {
      throwIfSignalAborted(options.signal, error);
      if (attempt < MAX_POST_RETRIES) {
        await delay(250 * (attempt + 1), options.signal);
        continue;
      }
      throw new AdapterError('ADAPTER_ERROR', 'OpenCode message request failed: ' + errorMessage(error), { cause: error });
    }

    const payload = await readResponse(response);
    const envelope = asEnvelope(payload);
    if (envelope?.info.error !== undefined
      && isRetryableProviderError(envelope.info.error)
      && attempt < MAX_POST_RETRIES) {
      await delay(250 * (attempt + 1), options.signal);
      continue;
    }
    if (isRetryableStatus(response.status) && attempt < MAX_POST_RETRIES) {
      await delay(250 * (attempt + 1), options.signal);
      continue;
    }
    if (response.status === 429 || !response.ok) throw responseError(response, payload);
    if (payload !== null && envelope === null) {
      throw new AdapterError('ADAPTER_ERROR', 'OpenCode message response did not contain an info object and parts array.');
    }
    return envelope;
  }
}

async function getMessages(
  fetchImpl: typeof fetch,
  url: string,
  signal: AbortSignal,
): Promise<MessageEnvelope[]> {
  const response = await request(fetchImpl, url, { method: 'GET', signal });
  const payload = await readResponse(response);
  if (!response.ok) throw responseError(response, payload);
  if (!Array.isArray(payload)) {
    throw new AdapterError('ADAPTER_ERROR', 'OpenCode message-list response was not an array.');
  }
  return payload.map(asEnvelope).filter((message): message is MessageEnvelope => message !== null);
}

/** Best effort: a failed or slow abort request must not hide the CANCELLED or TIMEOUT result. */
async function abortSession(fetchImpl: typeof fetch, url: string): Promise<void> {
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      signal: AbortSignal.timeout(ABORT_REQUEST_TIMEOUT_MS),
    });
    await response.text();
  } catch {
    // The turn already ended for Quorum; there is nothing more to do here.
  }
}

async function request(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    throwIfSignalAborted(init.signal, error);
    throw error;
  }
}

async function readResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function asEnvelope(value: unknown): MessageEnvelope | null {
  if (!isRecord(value) || !isRecord(value.info) || !Array.isArray(value.parts)) return null;
  return { info: value.info, parts: value.parts };
}

function finalAssistant(value: MessageEnvelope | null): MessageEnvelope | null {
  if (value?.info.role !== 'assistant') return null;
  return value;
}

function lastAssistant(messages: MessageEnvelope[]): MessageEnvelope | null {
  const last = messages.at(-1);
  return last?.info.role === 'assistant' ? last : null;
}

function throwIfMessageFailed(message: MessageEnvelope): void {
  if (message.info.error === undefined || message.info.error === null) return;
  const detail = message.info.error;
  const text = errorMessage(detail);
  if (isRateLimitError(detail)) {
    throw new AdapterError('RATE_LIMITED', text, { resetAt: messageErrorResetAt(detail) });
  }
  throw new AdapterError('ADAPTER_ERROR', 'OpenCode assistant message failed: ' + text);
}

function turnUsage(message: MessageEnvelope, prompt: string, text: string): TurnResult {
  const tokens = isRecord(message.info.tokens) ? message.info.tokens : {};
  const cache = isRecord(tokens.cache) ? tokens.cache : {};
  const input = tokenField(tokens.input) ?? estimateTokens(prompt);
  const output = tokenField(tokens.output) ?? estimateTokens(text);
  const contextTokens = input + (tokenField(cache.read) ?? 0) + (tokenField(cache.write) ?? 0);
  return {
    text,
    usage: { inputTokens: input, outputTokens: output },
    contextTokens,
  };
}

function tokenField(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.ceil(value)
    : null;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || (status >= 500 && status <= 599);
}

function isRetryableProviderError(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const data = value.data;
  if (value.name === 'APIError' && isRecord(data) && data.isRetryable === true) return true;
  const status = errorStatus(value);
  return status !== undefined && isRetryableStatus(status);
}

function errorStatus(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ['statusCode', 'status', 'httpStatus'] as const) {
    const status = Number(value[key]);
    if (Number.isInteger(status) && status > 0) return status;
  }
  if (isRecord(value.data)) return errorStatus(value.data);
  if (isRecord(value.error)) return errorStatus(value.error);
  return undefined;
}

function isRateLimitError(value: unknown): boolean {
  if (typeof value === 'string') return /rate[\s_-]?limit|usage[\s_-]?limit/i.test(value);
  if (!isRecord(value)) return false;
  if (typeof value.name === 'string' && /rate[\s_-]?limit|usage[\s_-]?limit/i.test(value.name)) return true;
  if (errorStatus(value) === 429) return true;
  if (typeof value.message === 'string' && /rate[\s_-]?limit|usage[\s_-]?limit/i.test(value.message)) return true;
  if (typeof value.error === 'string' && isRateLimitError(value.error)) return true;
  if (isRecord(value.data) && isRateLimitError(value.data)) return true;
  if (isRecord(value.error) && isRateLimitError(value.error)) return true;
  return false;
}

function messageErrorResetAt(value: unknown): number | undefined {
  const reset = timestampToMillis(findResetValue(value));
  if (reset !== undefined || !isRecord(value)) return reset;
  const headers = isRecord(value.data) && isRecord(value.data.responseHeaders)
    ? value.data.responseHeaders
    : isRecord(value.responseHeaders) ? value.responseHeaders : undefined;
  if (headers === undefined) return undefined;
  const retryAfter = headers['retry-after'];
  if (typeof retryAfter === 'string') {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Date.now() + seconds * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return date;
  }
  const resetHeader = headers['x-ratelimit-reset'] ?? headers['ratelimit-reset'];
  return typeof resetHeader === 'string' ? timestampToMillis(Number(resetHeader)) : undefined;
}

function responseError(response: Response, payload: unknown): AdapterError {
  const message = errorMessage(payload) || response.statusText || ('HTTP ' + response.status);
  if (response.status === 429 || /rate[\s_-]?limit|usage[\s_-]?limit/i.test(message)) {
    return new AdapterError('RATE_LIMITED', message, { resetAt: resetAt(response, payload) });
  }
  return new AdapterError('ADAPTER_ERROR', 'OpenCode HTTP ' + response.status + ': ' + message);
}

function resetAt(response: Response, payload: unknown): number | undefined {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Date.now() + seconds * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return date;
  }
  const headers = response.headers;
  const headerReset = headers.get('x-ratelimit-reset') ?? headers.get('ratelimit-reset');
  if (headerReset !== null) return timestampToMillis(Number(headerReset));
  const bodyReset = findResetValue(payload);
  return timestampToMillis(bodyReset);
}

function findResetValue(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const own = value.resetAt ?? value.resetsAt ?? value.reset_at ?? value.resets_at;
  if (typeof own === 'number') return own;
  if (isRecord(value.error)) return findResetValue(value.error);
  if (isRecord(value.data)) return findResetValue(value.data);
  return undefined;
}

function timestampToMillis(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return value < 1e12 ? value * 1000 : value;
}

function errorMessage(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return value === null || value === undefined ? '' : String(value);
  if (typeof value.message === 'string') return value.message;
  if (typeof value.error === 'string') return value.error;
  if (isRecord(value.error)) return errorMessage(value.error);
  if (isRecord(value.data)) return errorMessage(value.data);
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function throwIfAborted(callerSignal: AbortSignal, timeoutSignal: AbortSignal): void {
  if (callerSignal.aborted) throw new AdapterError('CANCELLED', 'OpenCode turn was cancelled.');
  if (timeoutSignal.aborted) throw new AdapterError('TIMEOUT', 'OpenCode turn timed out.');
}

function throwIfSignalAborted(signal: AbortSignal | null | undefined, cause?: unknown): void {
  if (signal?.aborted) {
    throw new AdapterError('CANCELLED', 'OpenCode request was cancelled.', { cause });
  }
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  throwIfSignalAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      signal.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      reject(signal.reason instanceof Error ? signal.reason : new Error('OpenCode request aborted.'));
    }
    signal.addEventListener('abort', aborted, { once: true });
  });
}
