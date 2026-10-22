import type { Instance } from 'ink';

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/**
 * Unmounting restores the main screen and cooked mode. Signals unmount; a crash also unmounts before the
 * process exits, so a throw in a stream handler never leaves the shell in raw mode on the alternate screen.
 */
export function registerTerminalCleanup(
  instance: Pick<Instance, 'unmount'>,
  target: Pick<NodeJS.Process, 'on' | 'removeListener' | 'exit'> = process,
  stderr: Pick<NodeJS.WriteStream, 'write'> = process.stderr,
): () => void {
  const stop = () => instance.unmount();
  const crash = (error: unknown) => {
    try { instance.unmount(); } finally {
      stderr.write(`quorum tui: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      target.exit(1);
    }
  };
  for (const signal of SIGNALS) target.on(signal, stop);
  target.on('uncaughtException', crash);
  target.on('unhandledRejection', crash);
  return () => {
    for (const signal of SIGNALS) target.removeListener(signal, stop);
    target.removeListener('uncaughtException', crash);
    target.removeListener('unhandledRejection', crash);
  };
}
