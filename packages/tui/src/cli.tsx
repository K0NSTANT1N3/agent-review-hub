#!/usr/bin/env node
import { render, type Instance } from 'ink';
import { App } from './app.js';
import { QuorumClient } from './api-client.js';
import { normalizeLeaderUrl, parseFlags, resolveConfig } from './config.js';
import { attachTask, localControl, spawnResume } from './attach.js';
import { initialState, reducer, type State } from './store.js';
import { refreshTask } from './controller.js';
import { handoffTerminal, registerTerminalCleanup } from './terminal.js';

const HELP = `quorum-tui [--url <http(s) Leader URL>] [--token <token>]

Local attach: --node-config <quorum.node.json> or QUORUM_NODE_CONFIG.
Connection: flags, then QUORUM_URL / QUORUM_TOKEN, then the quorum CLI config.
Config: QUORUM_CONFIG, else XDG_CONFIG_HOME/quorum/cli.json, else ~/.config/quorum/cli.json.
Keyboard: tab panes, ↑/↓ select, enter open/send, a approve, s send back,
p pause/resume, t attach (y/n), c cancel (y/n), n new task, / filter, m message mode, ? help, q quit.
`;

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) { process.stdout.write(HELP); return; }
  if (flags.version) { process.stdout.write('quorum-tui 0.1.0\n'); return; }
  const config = resolveConfig(flags, process.env);
  if (!config.url || !config.token) throw new Error('Set --url and --token, or configure the quorum CLI first. See quorum-tui --help.');
  const url = normalizeLeaderUrl(config.url);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('quorum-tui needs an interactive terminal.');
  const client = new QuorumClient(url, config.token);
  let instance: Instance | undefined;
  let removeHandlers: (() => void) | undefined;
  let seed: State = initialState;
  let selected: number | undefined;
  let attaching = false;
  let closed = false;
  let attachError: string | undefined;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const nodeConfig = flags['node-config'] ?? process.env.QUORUM_NODE_CONFIG;
  function mount(): void {
    if (closed) return;
    const element = <App client={client} url={url} token={config.token!} warning={config.warning}
      seed={seed} initialTaskId={selected} onAttach={attach} attaching={attaching} attachError={attachError} />;
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

main().catch((error: unknown) => {
  process.stderr.write(`quorum-tui: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
