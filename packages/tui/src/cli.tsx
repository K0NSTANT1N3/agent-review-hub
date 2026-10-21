#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { startTui } from './start.js';
import { normalizeLeaderUrl, parseFlags, resolveConfig } from './config.js';

const HELP = `quorum-tui [--url <http(s) Leader URL>] [--token <token>]

Connection: flags, then QUORUM_URL / QUORUM_TOKEN, then the quorum CLI config.
Config: QUORUM_CONFIG, else XDG_CONFIG_HOME/quorum/cli.json, else ~/.config/quorum/cli.json.
Keyboard: tab panes, ↑/↓ select, enter open/send, a approve, s send back,
p pause/resume, c cancel (y/n), n new task, / filter, m message mode, ? help, q quit.
`;

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) { process.stdout.write(HELP); return; }
  if (flags.version) { process.stdout.write(`quorum-tui ${JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version}\n`); return; }
  const config = resolveConfig(flags, process.env);
  if (!config.url || !config.token) throw new Error('Set --url and --token, or configure the quorum CLI first. See quorum-tui --help.');
  const url = normalizeLeaderUrl(config.url);
  await startTui({ url, token: config.token, warning: config.warning });
}

main().catch((error: unknown) => {
  process.stderr.write(`quorum-tui: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
