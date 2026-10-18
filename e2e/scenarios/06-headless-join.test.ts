import { execFile } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as nodePkg from '@quorum/node';
import { parseNodeConfig } from '@quorum/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { Api, waitForState } from '../helpers/api.js';
import { E2E_READY, Harness } from '../helpers/harness.js';
import { anyTask, approve, authorDone } from '../helpers/mock-script.js';
import { GREET, readMain } from '../helpers/toy-project.js';

// A server setup with no desktop app: `quorum-leader invite` prints join codes and `quorum-node join`
// turns each one into a Node config. Both run as real CLI processes from the built packages.

const run = promisify(execFile);
const leaderCli = join(import.meta.dirname, '../../packages/leader/dist/cli.js');
const nodeCli = join(import.meta.dirname, '../../packages/node/dist/cli.js');

describe.skipIf(!E2E_READY)('headless invite and join', () => {
  let h: Harness;
  afterEach(async () => h?.close());

  it('invite -> join -> start: a task authored and reviewed by joined Nodes merges', async () => {
    h = await Harness.create();
    await h.startLeader();
    const leaderConfigPath = join(h.dir, 'quorum.leader.json');
    await writeFile(leaderConfigPath, JSON.stringify(h.leaderConfig));
    const script = join(h.dir, 'mock.json');
    await writeFile(script, JSON.stringify({ author: anyTask([authorDone({ 'src/greet.js': GREET.withDefault })]), reviewer: anyTask([approve()]) }));

    for (const name of ['Alice', 'Bob']) {
      const invite = await run(process.execPath, [leaderCli, 'invite', '--config', leaderConfigPath, '--name', name, '--public-host', '127.0.0.1']);
      const joinCode = invite.stdout.trim();
      expect(joinCode).toMatch(/^quorum1\./);
      const configPath = join(h.dir, `${name}.node.json`);
      const joined = await run(process.execPath, [nodeCli, 'join', joinCode, '--config', configPath, '--data-dir', join(h.dir, name), '--adapter', 'mock', '--mock-script', script]);
      expect(joined.stdout).toContain(`quorum-node start --config ${configPath}`);
      expect((await stat(configPath)).mode & 0o777).toBe(0o600);

      const config = parseNodeConfig(JSON.parse(await readFile(configPath, 'utf8')));
      expect(config).toMatchObject({ agentId: `${name.toLowerCase()}-agent`, leaderUrl: `ws://127.0.0.1:${h.port}/ws/node`, lendMode: 'always' });
      const daemon = await nodePkg.startDaemon(config);
      h.agents.set(config.agentId, { id: config.agentId, owner: name, token: config.token, api: new Api(h.httpUrl, config.token), config, daemon });
    }

    const alice = h.agent('alice-agent');
    const task = await alice.api.createTask({ title: 'Default name from a VPS', description: 'greet() with no args says Hello world' });
    const done = await waitForState(alice.api, task.id, 'MERGED');
    expect(done.conversations[0]).toMatchObject({ authorAgentId: 'alice-agent', reviewerAgentId: 'bob-agent' });
    expect(await readMain(h.bare, 'src/greet.js')).toBe(GREET.withDefault);
  });
});
