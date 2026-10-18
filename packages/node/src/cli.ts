#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pino from 'pino';
import { parseNodeConfig } from '@quorum/protocol';
import { startDaemon } from './daemon.js';

interface CliOptions {
  configPath: string;
  assumeIdle: boolean;
  insecure: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const configText = await readFile(resolve(options.configPath), 'utf8');
  const config = parseNodeConfig(JSON.parse(configText) as unknown);
  const logger = pino().child({ agentId: config.agentId });
  const handle = await startDaemon(config, {
    ...(options.assumeIdle ? { assumeIdle: true } : {}),
    ...(options.insecure ? { insecure: true } : {}),
  });
  logger.info('node daemon started');

  await new Promise<void>((resolveStop) => {
    let stopping = false;
    const shutdown = (signal: NodeJS.Signals): void => {
      if (stopping) return;
      stopping = true;
      logger.info({ signal }, 'stopping node daemon');
      void handle.stop().then(
        () => resolveStop(),
        (error: unknown) => {
          logger.error({ error }, 'node daemon shutdown failed');
          process.exitCode = 1;
          resolveStop();
        },
      );
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  });
}

function parseArgs(args: string[]): CliOptions {
  if (args[0] !== 'start') throw new Error('Usage: quorum-node start --config <path> [--assume-idle] [--insecure]');
  let configPath: string | undefined;
  let assumeIdle = false;
  let insecure = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--config') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('--config requires a path');
      if (configPath !== undefined) throw new Error('--config may only be provided once');
      configPath = value;
      index += 1;
    } else if (arg === '--assume-idle') {
      assumeIdle = true;
    } else if (arg === '--insecure') {
      insecure = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (configPath === undefined) throw new Error('Missing required --config <path>');
  return { configPath, assumeIdle, insecure };
}

void main().catch((error: unknown) => {
  pino().fatal({ error }, 'could not start node daemon');
  process.exitCode = 1;
});
