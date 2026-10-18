import {
  API_ROUTES,
  apiPath,
  type ApiResponse,
  type ApiRouteName,
  type CreateDirectiveRequest,
  type CreateTaskRequest,
  type DirectiveView,
  type TaskDetail,
  type TaskState,
  type TaskView,
} from '@quorum/protocol';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    route: string,
  ) {
    super(`${route} → HTTP ${status}: ${JSON.stringify(body)}`);
  }
}

/** Minimal typed client over API_ROUTES, authenticated as one agent. */
export class Api {
  constructor(
    readonly baseUrl: string,
    readonly token: string,
  ) {}

  async call<R extends ApiRouteName>(
    route: R,
    opts: { id?: number | string; body?: unknown; query?: Record<string, string> } = {},
  ): Promise<ApiResponse<R>> {
    const def = API_ROUTES[route];
    const url = new URL(apiPath(route, opts.id), this.baseUrl);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const init: RequestInit = { method: def.method, headers: { authorization: `Bearer ${this.token}` } };
    if (def.method !== 'GET') {
      init.headers = { ...init.headers, 'content-type': 'application/json' };
      init.body = JSON.stringify(opts.body ?? {});
    }
    const res = await fetch(url, init);
    const text = await res.text();
    const json: unknown = text === '' ? null : JSON.parse(text);
    if (res.status !== def.status) throw new ApiError(res.status, json, `${def.method} ${url.pathname}`);
    return def.response.parse(json) as ApiResponse<R>;
  }

  /** Returns the HTTP status without throwing (for negative tests). */
  async status(route: ApiRouteName, opts: { id?: number | string; body?: unknown } = {}): Promise<{ status: number; body: unknown }> {
    try {
      await this.call(route, opts);
      return { status: API_ROUTES[route].status, body: null };
    } catch (error) {
      if (error instanceof ApiError) return { status: error.status, body: error.body };
      throw error;
    }
  }

  createTask(req: CreateTaskRequest): Promise<TaskView> {
    return this.call('createTask', { body: req });
  }
  getTask(id: number): Promise<TaskDetail> {
    return this.call('getTask', { id });
  }
  approve(id: number): Promise<TaskView> {
    return this.call('approveTask', { id });
  }
  cancel(id: number): Promise<TaskView> {
    return this.call('cancelTask', { id });
  }
  sendBack(id: number, comment: string): Promise<TaskView> {
    return this.call('sendBackTask', { id, body: { comment } });
  }
  createDirective(req: CreateDirectiveRequest): Promise<DirectiveView> {
    return this.call('createDirective', { body: req });
  }
  getDirective(id: string): Promise<DirectiveView> {
    return this.call('getDirective', { id });
  }
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

/** Polls `probe` until `done` holds. On timeout, throws with the last observed value. */
export async function waitFor<T>(
  label: string,
  probe: () => Promise<T>,
  done: (value: T) => boolean,
  { timeoutMs = 30_000, intervalMs = 100 }: WaitOptions = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      last = await probe();
      if (done(last)) return last;
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const detail = last === undefined ? String(lastError) : JSON.stringify(summarize(last), null, 2);
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}; last: ${detail}`);
}

function summarize(value: unknown): unknown {
  // Task details get large; keep what helps debugging.
  if (value !== null && typeof value === 'object' && 'task' in value && 'events' in value) {
    const d = value as TaskDetail;
    return {
      state: d.task.state,
      escalationReason: d.task.escalationReason,
      pauseReason: d.task.pauseReason,
      round: d.task.reviewRound,
      events: d.events.map((e) => `${e.fromState ?? '∅'}→${e.toState} (${e.reason})`),
      issues: d.issues.map((i) => `${i.code} ${i.severity} ${i.status}`),
    };
  }
  return value;
}

export function waitForState(api: Api, id: number, states: TaskState | TaskState[], opts?: WaitOptions): Promise<TaskDetail> {
  const want = Array.isArray(states) ? states : [states];
  return waitFor(`task ${id} in ${want.join('|')}`, () => api.getTask(id), (d) => want.includes(d.task.state), opts);
}

/** The ordered list of states a task has passed through. */
export function stateHistory(detail: TaskDetail): TaskState[] {
  return detail.events.map((e) => e.toState);
}
