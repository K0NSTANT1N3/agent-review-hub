import { expect, it } from 'vitest';
import { parseLeaderConfig, type CmdFrame } from '@quorum/protocol';
import { EventHandlers } from '../../src/core/handlers.js';
import { LockManager } from '../../src/core/locks.js';
import { transitionToAuthorState } from '../../src/core/state-machine.js';
import { openDatabase } from '../../src/db/repo.js';

it('a send-back before the first review finished restarts the review instead of stranding the task', () => {
  const db = openDatabase(':memory:');
  const now = 100_000;
  const frames: CmdFrame[] = [];
  const config = parseLeaderConfig({ repo: { remoteUrl: 'file:///unused' } });
  for (const [id, owner] of [['alice', 'Alice'], ['bob', 'Bob']] as const) {
    db.agents.insert({ id, owner_name: owner, token_hash: `h${id}`, status: 'online', last_heartbeat_at: now, created_at: now });
  }
  for (const [id, agent] of [['a', 'alice'], ['b', 'bob']] as const) db.sessions.insert({ id, agent_id: agent, state: 'idle', created_at: now, last_used_at: now });
  const task = db.tasks.insert({
    title: 'F', description: 'd', requester_agent_id: 'alice', author_agent_id: 'alice', author_session_id: 'a', state: 'IN_REVIEW',
    branch: 'quorum/task-1', base_commit: 'aaaaaaa', head_commit: 'bbbbbbb', created_at: now, updated_at: now, state_entered_at: now,
  });
  const locks = new LockManager(db, { leaseSec: 120, now: () => now, deliver: (_agent, frame) => { frames.push(frame); } });
  const handlers = new EventHandlers(db, config, locks, { now: () => now });
  locks.lockSession('a', 'task', String(task.id), 'author');
  locks.lockSession('b', 'task', String(task.id), 'reviewer');
  db.conversations.insert({
    id: 'conv', task_id: task.id, author_agent_id: 'alice', author_session_id: 'a', reviewer_agent_id: 'bob', reviewer_session_id: 'b', state: 'active', created_at: now,
  });
  handlers.sendReview(task.id, 'conv', 'start');
  // What POST /send-back does from IN_REVIEW: cancel the reviewer turn and hand the task back to the author.
  locks.sendToSession('b', { type: 'task.cancel', sid: 'b', taskId: task.id });
  transitionToAuthorState(db, task.id, 'AUTHORING', { reason: 'sent_back_by_human', actor: 'human:alice', at: now });
  const revise = handlers.sendAuthor(task.id, 'revise');

  handlers.handle('alice', {
    type: 'author.submitted', sid: 'a', taskId: task.id, inReplyTo: revise.msgId, status: 'done', summary: 'fixed', responses: [],
    headCommit: 'ccccccc', baseCommit: 'aaaaaaa', filesChanged: ['x'], diffLines: 1,
    tests: { passed: true, exitCode: 0, outputTail: '', durationMs: 1, timedOut: false },
    usage: { inputTokens: 1, outputTokens: 1, contextTokens: 1 },
  });

  expect(db.tasks.require(task.id).state).toBe('IN_REVIEW');
  const reviews = frames.filter((f) => f.cmd.type.startsWith('review.'));
  expect(reviews.map((f) => f.cmd.type)).toEqual(['review.start', 'review.start']);
  expect(reviews.at(-1)!.cmd).toMatchObject({ sid: 'b', headCommit: 'ccccccc' });
});
