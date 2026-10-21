import { API_ROUTES, apiPath, type ApiResponse, type ApiRouteName, type TranscriptSession } from '@quorum/protocol';

export interface CallOptions {
  id?: number | string;
  body?: unknown;
  query?: Record<string, string>;
}

export interface QuorumApi {
  call<R extends ApiRouteName>(route: R, options?: CallOptions): Promise<ApiResponse<R>>;
}

export const OWNER_TOKEN_HELP = 'Approve/send back/pause/cancel need an owner token (Settings → Agent CLI access, or quorum-leader add-token --scope owner).';
const ownerActions = new Set<ApiRouteName>(['approveTask', 'sendBackTask', 'pauseTask', 'resumeTask', 'cancelTask']);

export class ClientError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ClientError';
  }
}

// Small typed HTTP client adapted from packages/cli/src/client.ts.
export class QuorumClient implements QuorumApi {
  private readonly abort = new AbortController();
  constructor(readonly baseUrl: string, private readonly token: string, private readonly fetchImpl: typeof fetch = fetch) {}

  close(): void { this.abort.abort(); }

  async call<R extends ApiRouteName>(route: R, options: CallOptions = {}): Promise<ApiResponse<R>> {
    const definition = API_ROUTES[route];
    const url = new URL(apiPath(route, options.id), this.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    const init: RequestInit = { method: definition.method, headers, signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)]) };
    if (definition.method !== 'GET') {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(options.body ?? {});
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch {
      throw new ClientError(0, 'UNREACHABLE', `Cannot reach the Leader at ${url.origin}`);
    }
    const text = await response.text();
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = null; }
    if (response.status !== definition.status) {
      const data = json !== null && typeof json === 'object' ? json as Record<string, unknown> : {};
      const message = typeof data.message === 'string' ? data.message : (text || response.statusText);
      const help = response.status === 403 && ownerActions.has(route) ? ` ${OWNER_TOKEN_HELP}` : '';
      throw new ClientError(response.status, typeof data.error === 'string' ? data.error : 'HTTP_ERROR', `HTTP ${response.status}: ${message}${help}`);
    }
    return definition.response.parse(json) as ApiResponse<R>;
  }
}

export async function loadTranscript(client: QuorumApi, taskId: number): Promise<{ supported: boolean; sessions: TranscriptSession[] }> {
  try {
    return { supported: true, ...(await client.call('getTaskTranscript', { id: taskId })) };
  } catch (error) {
    if (error instanceof ClientError && (error.status === 404 || (error.status === 500 && /not[ _-]?implemented/i.test(error.message)))) {
      return { supported: false, sessions: [] };
    }
    throw error;
  }
}
