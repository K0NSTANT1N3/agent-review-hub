import { render } from 'ink';
import { createElement } from 'react';
import { App } from './app.js';
import { QuorumClient } from './api-client.js';
import { registerTerminalCleanup } from './terminal.js';

export interface TuiOptions {
  url: string;
  token: string;
  warning?: string;
}

/** Shared by quorum tui and the standalone quorum-tui bin. No CLI side effects on import. */
export async function startTui({ url, token, warning }: TuiOptions): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('quorum tui needs an interactive terminal.');
  const client = new QuorumClient(url, token);
  const instance = render(createElement(App, { client, url, token, warning }), { alternateScreen: true, exitOnCtrlC: false });
  const removeHandlers = registerTerminalCleanup(instance);
  try { await instance.waitUntilExit(); } finally { removeHandlers(); client.close(); instance.unmount(); }
}
