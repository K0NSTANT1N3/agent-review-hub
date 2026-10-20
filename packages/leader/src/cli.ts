#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import pino from 'pino';
import { ApiTokenScopeSchema } from '@quorum/protocol';
import { LeaderRuntimeConfigSchema, type LeaderRuntimeConfig } from './config.js';
import { addAgent, addApiToken, listAgents, revokeAgent, startLeader } from './index.js';
import { createInvite } from './invite.js';

const USAGE = `quorum-leader <command> --config <quorum.leader.json> [options]

Commands:
  start                          run the Leader
  invite --name <owner> [--public-host <host or https:// tunnel URL>] [--port <n>] [--id <agent id>] [--rotate]
                                 register a teammate's agent; prints a join code for the desktop app or quorum-node join
  add-agent --id <id> --owner <name>   register an agent (or rotate its token); prints the token once
  revoke-agent --id <id>         revoke an agent's token
  list-agents                    list registered agents
  add-token --id <agent id> [--label <text>] [--scope requester|owner]   mint an API token for the quorum CLI; prints it once`;

function loadConfig(path: string | undefined): LeaderRuntimeConfig {
  if (path === undefined) throw new Error('--config is required');
  return LeaderRuntimeConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      config: { type: 'string' },
      id: { type: 'string' },
      owner: { type: 'string' },
      label: { type: 'string' },
      scope: { type: 'string' },
      name: { type: 'string' },
      'public-host': { type: 'string' },
      port: { type: 'string' },
      rotate: { type: 'boolean' },
    },
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
    case 'invite': {
      const config = loadConfig(values.config);
      if (values.name === undefined) throw new Error('--name is required');
      const invite = await createInvite(config, {
        name: values.name,
        ...(values.id !== undefined ? { id: values.id } : {}),
        ...(values['public-host'] !== undefined ? { publicHost: values['public-host'] } : {}),
        ...(values.port !== undefined ? { port: Number(values.port) } : {}),
        ...(values.rotate === true ? { rotate: true } : {}),
      });
      for (const warning of invite.warnings) process.stderr.write(`Warning: ${warning}\n`);
      process.stderr.write(`Join code for ${invite.agentId} (Leader ${invite.leaderUrl}). It holds a secret token: send it privately.\n`);
      process.stdout.write(`${invite.joinCode}\n`);
      return;
    }
    case 'revoke-agent': {
      const config = loadConfig(values.config);
      if (values.id === undefined) throw new Error('--id is required');
      await revokeAgent(config.dbPath, values.id);
      return;
    }
    case 'add-token': {
      const config = loadConfig(values.config);
      if (values.id === undefined) throw new Error('--id is required');
      const scope = ApiTokenScopeSchema.parse(values.scope ?? 'requester');
      const { token } = await addApiToken(config.dbPath, { agentId: values.id, scope, ...(values.label !== undefined ? { label: values.label } : {}) });
      process.stdout.write(`${token}\n`);
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
