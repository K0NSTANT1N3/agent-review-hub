import { render, type Instance } from 'ink';
import { createElement } from 'react';
import { App } from './app.js';
import { QuorumClient } from './api-client.js';
import { attachTask, localControl, spawnResume } from './attach.js';
import { initialState, reducer, type State } from './store.js';
import { refreshTask } from './controller.js';
import { handoffTerminal, registerTerminalCleanup } from './terminal.js';

export interface TuiOptions {
  url: string;
  token: string;
  warning?: string;
  /** Local Node config with the Node's own token; enables `t` attach for sessions on this machine. */
  nodeConfig?: string;
}

/** Shared by quorum tui and the standalone quorum-tui bin. No CLI side effects on import. */
export async function startTui({ url, token, warning, nodeConfig }: TuiOptions): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('quorum tui needs an interactive terminal.');
  const client = new QuorumClient(url, token);
  let instance: Instance | undefined;
  let removeHandlers: (() => void) | undefined;
  let seed: State = initialState;
  let selected: number | undefined;
  let attaching = false;
  let closed = false;
  let attachError: string | undefined;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  function mount(): void {
    if (closed) return;
    const element = createElement(App, {
      client, url, token, warning, seed, initialTaskId: selected, onAttach: attach, attaching, attachError,
    });
    if (instance) { instance.rerender(element); return; }
    const current = render(element, { alternateScreen: true, exitOnCtrlC: false });
    instance = current;
    removeHandlers = registerTerminalCleanup(current);
    void current.waitUntilExit().then(() => { if (instance === current) finish(); });
  }
  function attach(taskId: number, sid: string, state: State): void {
    if (attaching) return;
    const session = state.sessions.find((item) => item.id === sid);
    if (!session) return;
    seed = state;
    selected = taskId;
    attaching = true;
    attachError = undefined;
    mount();
    void (async () => {
      try {
        const control = localControl(nodeConfig, url, session.agentId, sid, taskId);
        await attachTask(client, taskId, control, {
          run: (command) => handoffTerminal({
            suspend: async () => {
              removeHandlers?.();
              const current = instance;
              instance = undefined;
              current?.unmount();
              await current?.waitUntilExit();
              process.stdin.pause();
            },
            restore: mount,
          }, () => spawnResume(command)),
          reload: () => refreshTask(client, taskId, (action) => { seed = reducer(seed, action); }),
        });
      } catch (error) { attachError = error instanceof Error ? error.message : String(error); }
      finally {
        attaching = false;
        // Apply the fresh transcript and attach result in a new App state.
        removeHandlers?.();
        const current = instance;
        instance = undefined;
        current?.unmount();
        await current?.waitUntilExit();
        mount();
      }
    })();
  }
  mount();
  try { await done; } finally { closed = true; removeHandlers?.(); client.close(); instance?.unmount(); }
}
