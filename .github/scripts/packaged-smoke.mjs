// Run after build + stage, under xvfb-run. Seed with Node-compatible workspace modules;
// only the actual app uses the staged dependencies rebuilt for Electron.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { addAgent, startLeader } from '../../packages/leader/dist/index.js';
import { startDaemon } from '../../packages/node/dist/index.js';
import { Services } from '../../packages/desktop/dist/main/services.js';
import { DEFAULT_SETTINGS } from '../../packages/desktop/dist/shared/ipc.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const desktop = join(root, 'packages/desktop');
const electron = createRequire(join(desktop, 'package.json'))('electron');
assert(process.env.QUORUM_USER_DATA, 'QUORUM_USER_DATA must point to a fresh temporary directory');
assert(process.env.QUORUM_SMOKE_SCREENSHOT, 'QUORUM_SMOKE_SCREENSHOT is required');
assert.equal(process.env.QUORUM_START_PAGE, 'setup=host');
const hostDir = resolve(process.env.QUORUM_USER_DATA);
const setupShot = resolve(process.env.QUORUM_SMOKE_SCREENSHOT);
const shotsDir = dirname(setupShot);
const pages = [['tasks', 'tasks.png'], ['task=1', 'task-1.png'], ['team', 'team.png']];
const shots = [setupShot, ...pages.map(([, name]) => join(shotsDir, name))];
assert(!existsSync(join(hostDir, 'quorum-desktop.json')), 'Host data must be fresh');
for (const shot of shots) assert(!existsSync(shot), `Refusing to reuse an old screenshot: ${shot}`);
mkdirSync(hostDir, { recursive: true });
mkdirSync(shotsDir, { recursive: true });

const deps = {
  startLeader: (config) => startLeader(config),
  addAgent,
  startDaemon: (config, opts) => startDaemon(config, opts),
  secrets: {
    encrypt: (plain) => `plain:${plain}`,
    decrypt: (stored) => stored.slice(6),
    isEncrypted: () => false,
  },
};
const fixture = mkdtempSync(join(shotsDir, 'fixture-'));
const host = new Services(hostDir, deps);
const member = new Services(join(fixture, 'member'), deps);

async function waitFor(label, check) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function bothOnline(service) {
  const result = await service.api('listAgents');
  return result.ok && ['ana-agent', 'bo-agent'].every((id) => result.data.agents.some((agent) => agent.id === id && agent.status === 'online'));
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function validateShot(shot) {
  assert(existsSync(shot), `Missing screenshot: ${shot}`);
  const size = statSync(shot).size;
  assert(size >= 10 * 1024, `Screenshot is under 10 KB: ${shot} (${size} bytes)`);
  assert.equal(readFileSync(shot).subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `Invalid PNG: ${shot}`);
  console.log(`[smoke] ${shot}: ${size} bytes`);
}

async function capture(page, shot, configured = false) {
  console.log(`[smoke] Launch staged app at #${page}`);
  // Xvfb has no hardware GPU; use Chromium's software compositor for capturePage.
  const child = spawn(electron, [join(desktop, 'stage'), '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], {
    stdio: 'inherit',
    signal: globalThis.AbortSignal.timeout(45_000),
    killSignal: 'SIGKILL',
    env: {
      ...process.env,
      QUORUM_USER_DATA: hostDir,
      QUORUM_SMOKE_SCREENSHOT: shot,
      QUORUM_START_PAGE: page,
      // The window mounts before services.boot(); Tasks/Team retry after 15 seconds.
      QUORUM_SMOKE_DELAY_MS: configured ? '20000' : '2500',
    },
  });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Staged app at #${page} exited with ${signal ?? code}`));
    });
  });
  try {
    await Promise.all([
      exited,
      ...(configured ? [waitFor('both agents connected to the staged host', () => bothOnline(member))] : []),
    ]);
    validateShot(shot);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
}

try {
  await capture('setup=host', setupShot);

  // Same real Services/startLeader/startDaemon approach as desktop/test/services.test.ts.
  const bare = join(fixture, 'remote.git');
  const seed = join(fixture, 'seed');
  const git = (args, cwd = fixture) => execFileSync('git', args, { cwd, stdio: 'inherit' });
  git(['init', '--bare', '-b', 'main', bare]);
  git(['init', '-b', 'main', seed]);
  writeFileSync(join(seed, 'README.md'), '# Smoke team\n');
  git(['add', 'README.md'], seed);
  git(['-c', 'user.name=Smoke', '-c', 'user.email=smoke@quorum.invalid', 'commit', '-m', 'Seed smoke repository'], seed);
  git(['push', bare, 'main'], seed);
  const scriptPath = join(fixture, 'mock.json');
  writeFileSync(scriptPath, JSON.stringify({
    author: [{ match: { any: true }, turns: [{
      writeFiles: { 'README.md': '# Smoke team\n\nReviewed by a teammate.\n' },
      reply: { status: 'done', summary: 'Document the smoke team' },
    }] }],
    reviewer: [{ match: { any: true }, turns: [{
      reply: { verdict: 'approve', summary: 'Looks good', previousIssues: [], newIssues: [] },
    }] }],
  }));
  const settings = {
    ...DEFAULT_SETTINGS,
    lendMode: 'always',
    adapter: { type: 'mock', scriptPath, contextWindow: 200000 },
  };
  const state = await host.setupHost({
    ownerName: 'Ana', repoRemoteUrl: bare, mainBranch: 'main', port: await freePort(),
    publicHost: '127.0.0.1', restrictToIp: '127.0.0.1', settings,
  });
  assert.equal(state.leader?.running, true, state.leader?.error);
  assert.equal(state.node.running, true, state.node.error);
  const { joinCode } = await host.invite({ agentId: '', ownerName: 'Bo' });
  const joined = await member.setupJoin({ joinCode, settings });
  assert.equal(joined.node.running, true, joined.node.error);
  await waitFor('host and member online', () => bothOnline(host));
  const created = await host.api('createTask', { body: {
    title: 'Document the smoke team', description: 'Update the README and have a teammate review it.',
  } });
  assert(created.ok, JSON.stringify(created));
  assert.equal(created.data.id, 1);
  const detail = await waitFor('task 1 to merge', async () => {
    const result = await host.api('getTask', { id: 1 });
    assert(result.ok, JSON.stringify(result));
    assert(!['FAILED', 'ESCALATED', 'CANCELLED'].includes(result.data.task.state), JSON.stringify(result.data));
    return result.data.task.state === 'MERGED' && result.data;
  });
  assert.equal(detail.task.authorAgentId, 'ana-agent');
  assert(detail.conversations.some((conversation) => conversation.reviewerAgentId === 'bo-agent'));
  console.log('[smoke] Task 1 authored by Ana, reviewed by Bo, and merged');

  // Free the host's port/DB for the real Electron main process. The member stays alive
  // and reconnects to every staged host launch, exercising the persisted desktop setup.
  await host.stopAll();
  for (const [page, name] of pages) await capture(page, join(shotsDir, name), true);
  for (const shot of shots) validateShot(shot);
} finally {
  await member.stopAll();
  await host.stopAll();
}
