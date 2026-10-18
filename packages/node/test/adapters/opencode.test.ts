import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AdapterConfig } from '@quorum/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdapter } from '../../src/adapters/index.js';
import { createOpencodeAdapter } from '../../src/adapters/opencode.js';
import type { AgentAdapter } from '../../src/adapters/types.js';

interface CapturedRequest {
  method: string;
  pathname: string;
  searchParams: URLSearchParams;
  body: unknown;
}

interface FakeServer {
  baseUrl: string;
  close(): Promise<void>;
}

type RequestHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

const servers: FakeServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('OpenCode adapter', () => {
  it('creates a session in the worktree, sends the selected model, reads text and usage, and closes it', async () => {
    const requests: CapturedRequest[] = [];
    const server = await startServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const body = request.method === 'GET' || request.method === 'DELETE' ? null : await readBody(request);
      requests.push({
        method: request.method ?? '',
        pathname: url.pathname,
        searchParams: url.searchParams,
        body,
      });
      if (request.method === 'POST' && url.pathname === '/session') {
        return respondJson(response, { id: 'ses_test' });
      }
      if (request.method === 'POST' && url.pathname === '/session/ses_test/message') {
        return respondJson(response, assistantMessage({
          finish: 'stop',
          parts: [
            { type: 'text', text: 'The feature ' },
            { type: 'reasoning', text: 'ignored' },
            { type: 'text', text: 'is done.' },
          ],
          tokens: { input: 15, output: 5, cache: { read: 8, write: 2 } },
        }));
      }
      if (request.method === 'DELETE' && url.pathname === '/session/ses_test') {
        return respondJson(response, true);
      }
      return respondJson(response, { message: 'unexpected route' }, 404);
    });
    const adapter = await createAdapter(opencodeConfig(server.baseUrl));
    const session = await adapter.createSession({ cwd: '/repo/worktrees/sid-1', profile: 'author' });
    expect(session.nativeId).toBe('ses_test');
    const result = await run(adapter, session.nativeId!, 'Return a finished answer.');
    expect(result).toEqual({
      nativeId: 'ses_test',
      text: 'The feature is done.',
      usage: { inputTokens: 15, outputTokens: 5 },
      contextTokens: 25,
    });

    const createRequest = requests[0]!;
    expect(createRequest.method).toBe('POST');
    expect(createRequest.searchParams.get('directory')).toBe('/repo/worktrees/sid-1');
    const messageRequest = requests[1]!;
    const messageBody = messageRequest.body as {
      messageID: string;
      model: { providerID: string; modelID: string };
      parts: { type: string; text: string }[];
    };
    expect(messageRequest.pathname).toBe('/session/ses_test/message');
    expect(messageBody.messageID).toMatch(/^msg_/);
    expect(messageBody.model).toEqual({ providerID: 'provider-x', modelID: 'model-y' });
    expect(messageBody.parts).toEqual([{ type: 'text', text: 'Return a finished answer.' }]);

    await adapter.closeSession('ses_test');
    expect(requests.at(-1)?.method).toBe('DELETE');
    expect(requests.at(-1)?.pathname).toBe('/session/ses_test');
  });

  it('polls the session message list when the POST returns before the assistant stops', async () => {
    let polls = 0;
    const server = await startServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'POST' && url.pathname === '/session') {
        return respondJson(response, { id: 'ses_async' });
      }
      if (request.method === 'POST' && url.pathname === '/session/ses_async/message') {
        response.writeHead(202);
        response.end();
        return;
      }
      if (request.method === 'GET' && url.pathname === '/session/ses_async/message') {
        polls += 1;
        if (polls === 1) {
          return respondJson(response, [
            { info: { role: 'user' }, parts: [] },
            assistantMessage({ finish: 'tool-calls', parts: [] }),
          ]);
        }
        return respondJson(response, [
          { info: { role: 'user' }, parts: [] },
          assistantMessage({
            finish: 'stop',
            parts: [{ type: 'text', text: 'polled answer' }],
            tokens: { input: 4, output: 3, cache: { read: 2, write: 1 } },
          }),
        ]);
      }
      return respondJson(response, { message: 'unexpected route' }, 404);
    });
    const adapter = createOpencodeAdapter(opencodeConfig(server.baseUrl), { pollIntervalMs: 1 });
    const session = await adapter.createSession({ cwd: '/repo', profile: 'reviewer' });

    const result = await run(adapter, session.nativeId!, 'Review this change.');

    expect(result.text).toBe('polled answer');
    expect(result.contextTokens).toBe(7);
    expect(polls).toBe(2);
  });

  it('estimates token counts from text when the server omits usage fields', async () => {
    const server = await startServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'POST' && url.pathname === '/session') {
        return respondJson(response, { id: 'ses_estimate' });
      }
      if (request.method === 'POST' && url.pathname === '/session/ses_estimate/message') {
        return respondJson(response, assistantMessage({
          finish: 'stop',
          parts: [{ type: 'text', text: 'abcdefgh' }],
        }));
      }
      return respondJson(response, { message: 'unexpected route' }, 404);
    });
    const adapter = createOpencodeAdapter(opencodeConfig(server.baseUrl));
    const session = await adapter.createSession({ cwd: '/repo', profile: 'directive' });

    const result = await run(adapter, session.nativeId!, '123456789');

    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2 });
    expect(result.contextTokens).toBe(3);
  });

  it('retries transient provider responses twice and reuses the message id', async () => {
    const requests: CapturedRequest[] = [];
    let attempts = 0;
    const server = await startServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const body = request.method === 'POST' && url.pathname.endsWith('/message')
        ? await readBody(request)
        : null;
      requests.push({
        method: request.method ?? '',
        pathname: url.pathname,
        searchParams: url.searchParams,
        body,
      });
      if (request.method === 'POST' && url.pathname === '/session') {
        return respondJson(response, { id: 'ses_retry' });
      }
      if (request.method === 'POST' && url.pathname === '/session/ses_retry/message') {
        attempts += 1;
        if (attempts === 1) return respondJson(response, { message: 'temporary provider failure' }, 503);
        if (attempts === 2) {
          return respondJson(response, assistantMessage({
            finish: 'stop',
            parts: [],
            error: {
              name: 'APIError',
              data: { message: 'provider unavailable', statusCode: 503, isRetryable: true },
            },
          }));
        }
        return respondJson(response, assistantMessage({
          finish: 'stop',
          parts: [{ type: 'text', text: 'recovered' }],
          tokens: { input: 2, output: 1, cache: { read: 0, write: 0 } },
        }));
      }
      return respondJson(response, { message: 'unexpected route' }, 404);
    });
    const adapter = createOpencodeAdapter(opencodeConfig(server.baseUrl));
    const session = await adapter.createSession({ cwd: '/repo', profile: 'author' });

    const result = await run(adapter, session.nativeId!, 'Retry this once the provider recovers.');

    expect(result.text).toBe('recovered');
    expect(attempts).toBe(3);
    const messageIds = requests
      .filter((request) => request.method === 'POST' && request.pathname.endsWith('/message'))
      .map((request) => (request.body as { messageID: string }).messageID);
    expect(new Set(messageIds).size).toBe(1);
  });

  it('maps provider rate limits and reset timestamps to AdapterError', async () => {
    const server = await startServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'POST' && url.pathname === '/session') {
        return respondJson(response, { id: 'ses_limit' });
      }
      if (request.method === 'POST' && url.pathname === '/session/ses_limit/message') {
        response.setHeader('x-ratelimit-reset', '1893456000');
        return respondJson(response, { message: 'provider limit reached' }, 429);
      }
      return respondJson(response, { message: 'unexpected route' }, 404);
    });
    const adapter = createOpencodeAdapter(opencodeConfig(server.baseUrl));
    const session = await adapter.createSession({ cwd: '/repo', profile: 'author' });

    await expect(run(adapter, session.nativeId!, 'Do work.')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      resetAt: 1_893_456_000_000,
    });
  });

  it('maps a stalled request to TIMEOUT and caller aborts to CANCELLED', async () => {
    const server = await startServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'POST' && url.pathname === '/session') {
        return respondJson(response, { id: 'ses_abort' });
      }
      if (request.method === 'POST' && url.pathname === '/session/ses_abort/message') {
        await readBody(request);
        return;
      }
      return respondJson(response, { message: 'unexpected route' }, 404);
    });
    const adapter = createOpencodeAdapter(opencodeConfig(server.baseUrl));
    const session = await adapter.createSession({ cwd: '/repo', profile: 'author' });
    await expect(run(adapter, session.nativeId!, 'Timeout.', { timeoutMs: 25 }))
      .rejects.toMatchObject({ code: 'TIMEOUT' });

    const controller = new AbortController();
    const cancelled = run(adapter, session.nativeId!, 'Cancel.', {
      signal: controller.signal,
      timeoutMs: 1_000,
    });
    setTimeout(() => controller.abort(), 25);
    await expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('asks the server to abort the session when a turn times out or is cancelled', async () => {
    const aborts: string[] = [];
    const server = await startServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'POST' && url.pathname === '/session') {
        return respondJson(response, { id: 'ses_stop' });
      }
      if (request.method === 'POST' && url.pathname === '/session/ses_stop/message') {
        await readBody(request);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/session/ses_stop/abort') {
        aborts.push(url.pathname);
        return respondJson(response, true);
      }
      return respondJson(response, { message: 'unexpected route' }, 404);
    });
    const adapter = createOpencodeAdapter(opencodeConfig(server.baseUrl));
    const session = await adapter.createSession({ cwd: '/repo', profile: 'author' });

    await expect(run(adapter, session.nativeId!, 'Timeout.', { timeoutMs: 25 }))
      .rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(aborts).toEqual(['/session/ses_stop/abort']);

    const controller = new AbortController();
    const cancelled = run(adapter, session.nativeId!, 'Cancel.', {
      signal: controller.signal,
      timeoutMs: 1_000,
    });
    setTimeout(() => controller.abort(), 25);
    await expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(aborts).toEqual(['/session/ses_stop/abort', '/session/ses_stop/abort']);
  });

  it('does not abort the session when a turn completes', async () => {
    const aborts: string[] = [];
    const server = await startServer(async (request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'POST' && url.pathname === '/session') {
        return respondJson(response, { id: 'ses_done' });
      }
      if (request.method === 'POST' && url.pathname === '/session/ses_done/message') {
        return respondJson(response, assistantMessage({ finish: 'stop', parts: [{ type: 'text', text: 'done' }] }));
      }
      if (url.pathname.endsWith('/abort')) aborts.push(url.pathname);
      return respondJson(response, { message: 'unexpected route' }, 404);
    });
    const adapter = createOpencodeAdapter(opencodeConfig(server.baseUrl));
    const session = await adapter.createSession({ cwd: '/repo', profile: 'author' });

    await expect(run(adapter, session.nativeId!, 'Finish.')).resolves.toMatchObject({ text: 'done' });
    expect(aborts).toEqual([]);
  });
});

async function startServer(handler: RequestHandler): Promise<FakeServer> {
  const server: Server = createServer((request, response) => {
    void handler(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      respondJson(response, { message: error instanceof Error ? error.message : String(error) }, 500);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (address === null) throw new Error('Fake OpenCode server did not bind a port.');
  const fake: FakeServer = {
    baseUrl: 'http://127.0.0.1:' + address.port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
      server.closeAllConnections();
    }),
  };
  servers.push(fake);
  return fake;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString('utf8');
  return body.length === 0 ? null : JSON.parse(body) as unknown;
}

function respondJson(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function assistantMessage(options: {
  finish: string;
  parts: unknown[];
  tokens?: { input: number; output: number; cache: { read: number; write: number } };
  error?: unknown;
}): { info: Record<string, unknown>; parts: unknown[] } {
  return {
    info: {
      role: 'assistant',
      finish: options.finish,
      ...(options.tokens === undefined ? {} : { tokens: options.tokens }),
      ...(options.error === undefined ? {} : { error: options.error }),
    },
    parts: options.parts,
  };
}

function opencodeConfig(baseUrl: string): Extract<AdapterConfig, { type: 'opencode' }> {
  return {
    type: 'opencode',
    baseUrl,
    providerID: 'provider-x',
    modelID: 'model-y',
    contextWindow: 200_000,
  };
}

function run(
  adapter: AgentAdapter,
  nativeId: string,
  prompt: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
) {
  return adapter.runTurn({
    nativeId,
    cwd: '/repo',
    profile: 'author',
    prompt,
    signal: options.signal ?? new AbortController().signal,
    timeoutMs: options.timeoutMs ?? 5_000,
  });
}
