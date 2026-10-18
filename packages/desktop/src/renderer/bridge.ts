import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiResponse, ApiRouteName, UiEvent } from '@quorum/protocol';
import type { ApiCallOptions, QuorumBridge } from '../shared/ipc';

declare global {
  interface Window {
    quorum: QuorumBridge;
  }
}

export const bridge = (): QuorumBridge => window.quorum;

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Calls the Leader through the main process; throws ApiFailure on error. */
export async function call<R extends ApiRouteName>(route: R, options?: ApiCallOptions): Promise<ApiResponse<R>> {
  const res = await bridge().api(route, options);
  if (!res.ok) throw new ApiFailure(res.status, res.error, res.message);
  return res.data;
}

const uiListeners = new Set<(e: UiEvent) => void>();
let subscribed = false;

export function onUiEvent(listener: (e: UiEvent) => void): () => void {
  if (!subscribed) {
    subscribed = true;
    bridge().onUiEvent((e) => uiListeners.forEach((l) => l(e)));
  }
  uiListeners.add(listener);
  return () => uiListeners.delete(listener);
}

/**
 * Loads data and reloads it when a matching UI event arrives (debounced) or every `pollMs` as a fallback.
 */
export function useLive<T>(
  load: () => Promise<T>,
  deps: unknown[],
  opts: { events?: UiEvent['type'][]; pollMs?: number } = {},
): { data: T | undefined; error: string | null; reload: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const reload = useCallback(() => {
    loadRef
      .current()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    reload();
    const events = opts.events;
    const off =
      events === undefined
        ? () => {}
        : onUiEvent((e) => {
            if (!events.includes(e.type)) return;
            clearTimeout(timer.current);
            timer.current = setTimeout(reload, 150);
          });
    const poll = setInterval(reload, opts.pollMs ?? 15_000);
    return () => {
      off();
      clearInterval(poll);
      clearTimeout(timer.current);
    };
  }, deps);

  return { data, error, reload };
}

export function timeAgo(ts: number | null | undefined): string {
  if (ts === null || ts === undefined) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}

export function formatTokens(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}
