#!/usr/bin/env node
import { run } from './run.js';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const code = await run(process.argv.slice(2), {
  env: process.env,
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
  readStdin,
  stdinIsTTY: process.stdin.isTTY === true,
  stdoutIsTTY: process.stdout.isTTY === true,
});
process.exitCode = code;
