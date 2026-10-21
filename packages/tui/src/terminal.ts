import type { Instance } from 'ink';

export function registerTerminalCleanup(instance: Pick<Instance, 'unmount'>, target: Pick<NodeJS.Process, 'on' | 'removeListener'> = process): () => void {
  const stop = () => instance.unmount();
  target.on('SIGINT', stop);
  target.on('SIGTERM', stop);
  return () => { target.removeListener('SIGINT', stop); target.removeListener('SIGTERM', stop); };
}
