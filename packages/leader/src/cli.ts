#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import pino from 'pino';
import { parseLeaderConfig, type LeaderConfig } from '@quorum/protocol';
import { addAgent, listAgents, revokeAgent, startLeader } from './index.js';

const USAGE = `quorum-leader <command> --config <quorum.leader.json> [options]

Commands:
  start                          run the Leader
  add-agent --id <id> --owner <name>   register an agent (or rotate its token); prints the token once
  revoke-agent --id <id>         revoke an agent's token
  list-agents                    list registered agents`;

function loadConfig(path: string | undefined): LeaderConfig {
  if (path === undefined) throw new Error('--config is required');
  return parseLeaderConfig(JSON.parse(readFileSync(path, 'utf8')));
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: { config: { type: 'string' }, id: { type: 'string' }, owner: { type: 'string' } },
    allowPositionals: false,
  });
  switch (command) {
    case 'start': {
      const config = loadConfig(values.config);
      const logger = pino({ level: process.env.QUORUM_LOG_LEVEL ?? 'info', base: { component: 'leader' } });
      const leader = await startLeader(config, { logger });
      logger.info({ url: leader.url }, `Quorum Leader listening on port ${leader.port}`);
      const shutdown = () => void leader.close().then(() => process.exit(0));
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      return;
    }
    case 'add-agent': {
      const config = loadConfig(values.config);
      if (values.id === undefined || values.owner === undefined) throw new Error('--id and --owner are required');
      const { token } = await addAgent(config.dbPath, { id: values.id, owner: values.owner });
      process.stdout.write(`${token}\n`);
      return;
    }
    case 'revoke-agent': {
      const config = loadConfig(values.config);
      if (values.id === undefined) throw new Error('--id is required');
      await revokeAgent(config.dbPath, values.id);
      return;
    }
    case 'list-agents': {
      const config = loadConfig(values.config);
      for (const a of await listAgents(config.dbPath)) {
        process.stdout.write(`${a.id}\t${a.owner}\t${a.revoked ? 'revoked' : a.status}\n`);
      }
      return;
    }
    default:
      process.stdout.write(`${USAGE}\n`);
      process.exitCode = command === undefined || command === '--help' ? 0 : 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
