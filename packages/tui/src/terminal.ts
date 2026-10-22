import type { Instance } from 'ink';

export function registerTerminalCleanup(instance: Pick<Instance, 'unmount'>, target: Pick<NodeJS.Process, 'on' | 'removeListener'> = process): () => void {
  const stop = () => instance.unmount();
  target.on('SIGINT', stop);
  target.on('SIGTERM', stop);
  return () => { target.removeListener('SIGINT', stop); target.removeListener('SIGTERM', stop); };
}

/** Unmount restores Ink's raw mode, cursor and alternate screen before the child inherits stdio. */
export async function handoffTerminal<T>(terminal: { suspend(): void | Promise<void>; restore(): void }, run: () => Promise<T>): Promise<T> {
  try { await terminal.suspend(); return await run(); }
  finally { terminal.restore(); }
}
