import { API_ROUTES, apiPath, type ApiResponse, type ApiRouteName } from '@quorum/protocol';

/** A failed call: `status` 0 means the Leader could not be reached. */
export class ClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface CallOptions {
  id?: number | string;
  body?: unknown;
  query?: Record<string, string>;
}

/** Typed client for the Leader REST API. Every route, method and response schema comes from @quorum/protocol. */
export class QuorumClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async call<R extends ApiRouteName>(route: R, opts: CallOptions = {}): Promise<ApiResponse<R>> {
    const def = API_ROUTES[route];
    const url = new URL(apiPath(route, opts.id), this.baseUrl);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    const init: RequestInit = { method: def.method, headers, signal: AbortSignal.timeout(30_000) };
    if (def.method !== 'GET') {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body ?? {});
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
    } catch (error) {
      throw new ClientError(0, 'UNREACHABLE', `cannot reach the Leader at ${url.origin}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    if (res.status !== def.status) {
      const body = (json ?? {}) as { error?: string; message?: string };
      throw new ClientError(res.status, body.error ?? 'HTTP_ERROR', body.message ?? `HTTP ${res.status} from ${def.method} ${url.pathname}`);
    }
    return def.response.parse(json) as ApiResponse<R>;
  }
}

/** Accepts the Leader's http(s) base or its ws(s)://host:port/ws/node URL; returns the http(s) origin. */
export function normalizeLeaderUrl(input: string): string {
  const u = new URL(input.trim());
  if (u.protocol === 'ws:') u.protocol = 'http:';
  else if (u.protocol === 'wss:') u.protocol = 'https:';
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`unsupported Leader URL: ${input}`);
  return u.origin;
}
