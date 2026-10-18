import { execFileSync } from 'node:child_process';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseLeaderConfig, type CmdFrame, type LeaderConfig } from '@quorum/protocol';
import { EventHandlers } from '../../src/core/handlers.js';
import { LockManager } from '../../src/core/locks.js';
import { MAX_RETRYABLE_MERGE_FAILURES, MERGE_RETRY_BASE_MS, MERGE_RETRY_MAX_MS, MergeWorker } from '../../src/core/merge-worker.js';
import { openDatabase, type LeaderDb, type TaskRow } from '../../src/db/repo.js';
import { LeaderGit } from '../../src/git/leader-git.js';

let dir: string;
let bare: string;
let seed: string;
let db: LeaderDb;
let config: LeaderConfig;
let handlers: EventHandlers;
let locks: LockManager;
let commands: CmdFrame[];
let now: number;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();

function commitTo(branch: string, files: Record<string, string>, from = 'origin/main') {
  git(seed, 'fetch', 'origin');
  git(seed, 'checkout', '-B', branch, from);
  for (const [f, c] of Object.entries(files)) writeFileSync(join(seed, f), c);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', `change on ${branch}`);
  git(seed, 'push', '-f', 'origin', `${branch}:${branch}`);
}

function worker(beforePush?: () => Promise<void>, leaderGit = new LeaderGit(config.repo)) {
  return new MergeWorker({ db, config, git: leaderGit, handlers, now: () => now, ...(beforePush ? { beforePush } : {}) });
}

/** Makes the remote unreachable (as during a network blip) until the returned function restores it. */
function takeRemoteOffline(): () => void {
  const away = `${bare}.offline`;
  renameSync(bare, away);
  return () => renameSync(away, bare);
}

function queuedTask(branch: string, patch: Partial<Parameters<typeof db.tasks.insert>[0]> = {}): TaskRow {
  const t = db.tasks.insert({
    title: 'Add feature', description: 'd', requester_agent_id: 'alice', author_agent_id: 'alice', author_session_id: 'a',
    state: 'MERGE_QUEUED', branch, base_commit: 'aaaaaaa', head_commit: 'bbbbbbb', approved_at: now,
    created_at: now, updated_at: now, state_entered_at: now, ...patch,
  });
  locks.lockSession('a', 'task', String(t.id), 'author');
  locks.lockSession('b', 'task', String(t.id), 'reviewer');
  db.conversations.insert({ id: `c${t.id}`, task_id: t.id, author_agent_id: 'alice', author_session_id: 'a', reviewer_agent_id: 'bob', reviewer_session_id: 'b', state: 'active', created_at: now });
  db.mergeQueue.insert({ task_id: t.id, enqueued_at: now });
  return t;
}

async function run(w: MergeWorker) {
  w.kick();
  await w.settled();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'quorum-merge-'));
  bare = join(dir, 'remote.git');
  seed = join(dir, 'seed');
  execFileSync('git', ['init', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['init', '-b', 'main', seed]);
  writeFileSync(join(seed, 'quorum.json'), JSON.stringify({ testCommand: 'node test.js' }));
  writeFileSync(join(seed, 'test.js'), "if (require('fs').readFileSync('a.txt', 'utf8').includes('BROKEN')) { console.error('a.txt is BROKEN'); process.exit(1); }\n");
  writeFileSync(join(seed, 'a.txt'), 'one\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'init');
  git(seed, 'remote', 'add', 'origin', bare);
  git(seed, 'push', '-u', 'origin', 'main');

  now = 1_000_000;
  commands = [];
  db = openDatabase(':memory:');
  config = parseLeaderConfig({ repo: { remoteUrl: bare, clonePath: join(dir, 'leader-clone') }, limits: { maxSyncAttempts: 2 } });
  locks = new LockManager(db, { leaseSec: 120, now: () => now, deliver: (_a, f) => commands.push(f) });
  handlers = new EventHandlers(db, config, locks, { now: () => now });
  for (const id of ['alice', 'bob']) db.agents.insert({ id, owner_name: id, token_hash: 'x', created_at: now });
  db.sessions.insert({ id: 'a', agent_id: 'alice', state: 'idle', created_at: now, last_used_at: now });
  db.sessions.insert({ id: 'b', agent_id: 'bob', state: 'idle', created_at: now, last_used_at: now });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('merge worker (§14.3)', () => {
  it('squash-merges into main with trailers, releases locks and dequeues', async () => {
    commitTo('quorum/task-1', { 'a.txt': 'two\n' });
    const t = queuedTask('quorum/task-1');
    await run(worker());

    const after = db.tasks.require(t.id);
    expect(after.state).toBe('MERGED');
    expect(after.merged_commit).toBe(git(bare, 'rev-parse', 'main'));
    expect(git(bare, 'show', 'main:a.txt')).toBe('two');
    const message = git(bare, 'log', '-1', '--format=%B', 'main');
    expect(message).toContain(`Add feature (quorum #${t.id})`);
    expect(message).toContain(`Quorum-Task: ${t.id}`);
    expect(message).toContain('Quorum-Author: alice');
    expect(message).toContain('Quorum-Reviewer: bob');
    expect(message).toContain('Requested-By: alice');
    expect(git(bare, 'log', '--format=%P', '-1', 'main').split(' ')).toHaveLength(1);
    expect(db.mergeQueue.all()).toEqual([]);
    expect(db.sessions.require('a').state).toBe('idle');
    expect(db.sessions.require('b').state).toBe('idle');
    expect(db.conversations.require(`c${t.id}`).state).toBe('closed');
  });

  it('conflict → SYNCING with author.sync; at the sync limit → ESCALATED', async () => {
    commitTo('quorum/task-1', { 'a.txt': 'branch side\n' });
    commitTo('main', { 'a.txt': 'main side\n' });
    const t = queuedTask('quorum/task-1');
    db.agents.update('alice', { status: 'online', last_heartbeat_at: now });
    await run(worker());
    expect(db.tasks.require(t.id)).toMatchObject({ state: 'SYNCING', sync_attempts: 1 });
    expect(commands.at(-1)!.cmd).toMatchObject({ type: 'author.sync', sid: 'a', branch: 'quorum/task-1', mainBranch: 'main' });

    db.tasks.update(t.id, { state: 'MERGE_QUEUED', sync_attempts: 2 });
    await run(worker());
    expect(db.tasks.require(t.id)).toMatchObject({ state: 'ESCALATED', escalation_reason: 'sync_limit' });
    expect(git(bare, 'show', 'main:a.txt')).toBe('main side');
  });

  it('failing tests after the squash → AUTHORING with a system issue and author.revise', async () => {
    commitTo('quorum/task-1', { 'a.txt': 'BROKEN\n' });
    const t = queuedTask('quorum/task-1');
    db.agents.update('alice', { status: 'online', last_heartbeat_at: now });
    await run(worker());
    expect(db.tasks.require(t.id).state).toBe('AUTHORING');
    expect(db.issues.find({ task_id: t.id, source: 'system' })[0]).toMatchObject({ severity: 'blocking', status: 'open' });
    expect(commands.at(-1)!.cmd).toMatchObject({ type: 'author.revise', testFailure: expect.stringContaining('BROKEN') });
    expect(git(bare, 'show', 'main:a.txt')).toBe('one');
  });

  it('retries after a rejected push and still merges both changes', async () => {
    commitTo('quorum/task-1', { 'b.txt': 'from task\n' });
    const t = queuedTask('quorum/task-1');
    let raced = false;
    await run(
      worker(async () => {
        if (raced) return;
        raced = true;
        commitTo('main', { 'c.txt': 'concurrent\n' });
      }),
    );
    expect(db.tasks.require(t.id).state).toBe('MERGED');
    expect(git(bare, 'show', 'main:b.txt')).toBe('from task');
    expect(git(bare, 'show', 'main:c.txt')).toBe('concurrent');
  });

  it('processes the queue in approval order', async () => {
    commitTo('quorum/task-1', { 'x.txt': '1\n' });
    commitTo('quorum/task-2', { 'y.txt': '2\n' });
    const late = queuedTask('quorum/task-1', { approved_at: now + 10 });
    db.sessions.insert({ id: 'a2', agent_id: 'alice', state: 'idle', created_at: now, last_used_at: now });
    db.sessions.insert({ id: 'b2', agent_id: 'bob', state: 'idle', created_at: now, last_used_at: now });
    const early = db.tasks.insert({
      title: 'Early', description: 'd', requester_agent_id: 'alice', author_agent_id: 'alice', author_session_id: 'a2',
      state: 'MERGE_QUEUED', branch: 'quorum/task-2', approved_at: now, created_at: now, updated_at: now, state_entered_at: now,
    });
    db.mergeQueue.insert({ task_id: early.id, enqueued_at: now });
    await run(worker());
    const log = git(bare, 'log', '--format=%s', 'main').split('\n');
    expect(log.slice(0, 2)).toEqual([`Add feature (quorum #${late.id})`, `Early (quorum #${early.id})`]);
  });

  it('a transient fetch failure requeues with backoff, stops draining, then merges without escalating', async () => {
    commitTo('quorum/task-1', { 'x.txt': '1\n' });
    commitTo('quorum/task-2', { 'y.txt': '2\n' });
    const first = queuedTask('quorum/task-1');
    db.sessions.insert({ id: 'a2', agent_id: 'alice', state: 'idle', created_at: now, last_used_at: now });
    const second = db.tasks.insert({
      title: 'Second', description: 'd', requester_agent_id: 'alice', author_agent_id: 'alice', author_session_id: 'a2',
      state: 'MERGE_QUEUED', branch: 'quorum/task-2', approved_at: now + 1, created_at: now, updated_at: now, state_entered_at: now,
    });
    db.mergeQueue.insert({ task_id: second.id, enqueued_at: now });
    const w = worker();

    const restore = takeRemoteOffline();
    await run(w);
    expect(db.tasks.require(first.id)).toMatchObject({ state: 'MERGE_QUEUED', escalation_reason: null });
    expect(db.tasks.require(second.id).state).toBe('MERGE_QUEUED');
    expect(db.taskEvents.find({ task_id: first.id }).map((e) => e.reason)).toEqual(['merge_started', 'merge_retry']);
    expect(db.taskEvents.find({ task_id: second.id })).toEqual([]);
    expect(db.mergeQueue.all().map((q) => q.task_id).sort()).toEqual([first.id, second.id]);

    restore();
    now += MERGE_RETRY_BASE_MS - 1;
    await run(w);
    expect(db.tasks.require(first.id).state).toBe('MERGE_QUEUED');

    now += 1;
    await run(w);
    expect(db.tasks.require(first.id).state).toBe('MERGED');
    expect(db.tasks.require(second.id).state).toBe('MERGED');
    expect(git(bare, 'show', 'main:x.txt')).toBe('1');
    expect(git(bare, 'show', 'main:y.txt')).toBe('2');
  });

  it('escalates after repeated retryable failures', async () => {
    commitTo('quorum/task-1', { 'x.txt': '1\n' });
    const t = queuedTask('quorum/task-1');
    const w = worker();
    takeRemoteOffline();
    for (let i = 1; i < MAX_RETRYABLE_MERGE_FAILURES; i += 1) {
      await run(w);
      expect(db.tasks.require(t.id).state).toBe('MERGE_QUEUED');
      now += MERGE_RETRY_MAX_MS;
    }
    await run(w);
    expect(db.tasks.require(t.id)).toMatchObject({ state: 'ESCALATED', escalation_reason: 'merge_fetch_failed' });
  });

  it('a non-retryable error escalates at once and still leaves the clone clean', async () => {
    commitTo('quorum/task-1', { 'a.txt': 'two\n' });
    const t = queuedTask('quorum/task-1');
    const leaderGit = new LeaderGit(config.repo);
    leaderGit.projectConfig = () => Promise.reject(new Error('boom after the squash'));
    await run(worker(undefined, leaderGit));

    expect(db.tasks.require(t.id)).toMatchObject({ state: 'ESCALATED', escalation_reason: 'merge_error' });
    const clone = config.repo.clonePath;
    expect(git(clone, 'status', '--porcelain')).toBe('');
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(git(bare, 'rev-parse', 'main'));
    expect(git(bare, 'show', 'main:a.txt')).toBe('one');
  });
});
