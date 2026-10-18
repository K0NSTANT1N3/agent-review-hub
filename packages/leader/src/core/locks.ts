import { randomUUID } from 'node:crypto';
import { CommandSchema, type CmdFrame, type Command, type LockKind, type LockRole, type SessionOpenCommand, type SessionCloseCommand } from '@quorum/protocol';
import { type LeaderDb, type SessionRow } from '../db/repo.js';
import { isTerminal } from './state-machine.js';

export class LockError extends Error {
  constructor(message: string) { super(message); this.name = 'LockError'; }
}

export interface LockOptions {
  leaseSec: number;
  now?: () => number;
  deliver: (agentId: string, frame: CmdFrame) => void;
  onDeliveryError?: (error: unknown) => void;
}

export class LockManager {
  private readonly now: () => number;
  constructor(private readonly db: LeaderDb, private readonly options: LockOptions) {
    this.now = options.now ?? Date.now;
  }

  lockSession(sid: string, kind: LockKind, ref: string, role: LockRole): SessionRow {
    return this.db.withTx(() => {
      const session = this.db.sessions.require(sid);
      if (!['idle', 'opening'].includes(session.state)) throw new LockError('Session is not available for locking');
      if (kind === 'task') {
        const task = this.db.tasks.require(Number(ref));
        if (String(task.id) !== ref || isTerminal(task.state)) throw new LockError('Invalid task lock');
        if (role === 'directive') throw new LockError('Task cannot use a directive role');
        if (role === 'reviewer' && task.author_agent_id === session.agent_id) throw new LockError('Author cannot review its own task');
        if (role === 'author' && task.author_agent_id !== null && task.author_agent_id !== session.agent_id) throw new LockError('Wrong author agent');
      } else {
        const directive = this.db.directives.require(ref);
        if (role !== 'directive' || directive.agent_id !== session.agent_id || !['queued', 'running'].includes(directive.state)) {
          throw new LockError('Invalid directive lock');
        }
      }
      return this.db.sessions.update(sid, {
        state: 'locked', lock_kind: kind, lock_ref: ref, lock_role: role,
        lease_expires_at: this.now() + this.options.leaseSec * 1000, last_used_at: this.now(),
      });
    });
  }

  releaseSession(sid: string, toState: 'idle' | 'lost'): SessionRow {
    return this.db.withTx(() => {
      const session = this.db.sessions.require(sid);
      if (['closed', 'closing'].includes(session.state) || (toState === 'idle' && session.state !== 'locked')) {
        throw new LockError('Session cannot be released from this state');
      }
      return this.db.sessions.update(sid, {
        state: toState, lock_kind: null, lock_ref: null, lock_role: null,
        lease_expires_at: null, last_used_at: this.now(),
      });
    });
  }

  extendLease(agentId: string, aliveSids: readonly string[]): void {
    this.db.withTx(() => {
      const alive = new Set(aliveSids);
      for (const session of this.db.sessions.find({ agent_id: agentId, state: 'locked' })) {
        if (alive.has(session.id)) this.db.sessions.update(session.id, { lease_expires_at: this.now() + this.options.leaseSec * 1000 });
      }
    });
  }

  sendToSession(sid: string, raw: Command): CmdFrame {
    return this.db.withTx(() => {
      const command = CommandSchema.parse(raw);
      const session = this.db.sessions.require(sid);
      if (command.sid !== sid) throw new LockError('Command sid does not match target');
      if (command.type === 'session.open' || command.type === 'session.close') throw new LockError('Lifecycle commands use sendToAgent');
      if (session.state !== 'locked') throw new LockError('Session is not locked');
      const taskId = 'taskId' in command ? command.taskId : undefined;
      const directiveId = 'directiveId' in command ? command.directiveId : undefined;
      if ((taskId === undefined) === (directiveId === undefined)) throw new LockError('Command requires exactly one task or directive scope');
      if (taskId !== undefined && (session.lock_kind !== 'task' || session.lock_ref !== String(taskId))) throw new LockError('Wrong task lock');
      if (directiveId !== undefined && (session.lock_kind !== 'directive' || session.lock_ref !== directiveId)) throw new LockError('Wrong directive lock');
      const role = command.type.startsWith('author.') ? 'author' : command.type.startsWith('review.') ? 'reviewer' : command.type === 'directive.run' ? 'directive' : null;
      if (role !== null && role !== session.lock_role) throw new LockError('Wrong session role');
      const task = taskId === undefined ? undefined : this.db.tasks.require(taskId);
      if (role === 'author' && (task?.author_agent_id !== session.agent_id || task.author_session_id !== sid)) throw new LockError('Session is not the current task author');
      if (role === 'reviewer' && task?.author_agent_id === session.agent_id) throw new LockError('Author cannot review its own task');
      let seq: number | null = null;
      const conversationId = 'conversationId' in command ? command.conversationId : null;
      if (conversationId !== null) {
        const conversation = this.db.conversations.require(conversationId);
        const participant = role === 'author'
          ? conversation.author_session_id === sid && conversation.author_agent_id === session.agent_id
          : role === 'reviewer' && conversation.reviewer_session_id === sid && conversation.reviewer_agent_id === session.agent_id;
        if (conversation.state !== 'active' || conversation.task_id !== taskId || !participant) throw new LockError('Invalid conversation participant');
        if (task?.author_agent_id !== conversation.author_agent_id || task.author_session_id !== conversation.author_session_id) throw new LockError('Conversation author is no longer assigned');
        seq = conversation.next_seq;
        this.db.conversations.update(conversationId, { next_seq: seq + 1 });
      }
      return this.enqueue(session.agent_id, command, conversationId, seq);
    });
  }

  sendToAgent(agentId: string, raw: SessionOpenCommand | SessionCloseCommand): CmdFrame {
    return this.db.withTx(() => {
      const command = CommandSchema.parse(raw);
      if (command.type !== 'session.open' && command.type !== 'session.close') throw new LockError('Only lifecycle commands may bypass scoped delivery');
      this.db.agents.require(agentId);
      const session = this.db.sessions.require(command.sid);
      if (session.agent_id !== agentId) throw new LockError('Session belongs to another agent');
      if (command.type === 'session.open' && session.state !== 'opening') throw new LockError('Session is not opening');
      if (command.type === 'session.close' && session.state === 'locked') throw new LockError('Cannot close a locked session');
      return this.enqueue(agentId, command, null, null);
    });
  }

  private enqueue(agentId: string, command: Command, conversationId: string | null, seq: number | null): CmdFrame {
    const frame: CmdFrame = { kind: 'cmd', msgId: randomUUID(), cmd: command };
    this.db.messages.insert({
      id: frame.msgId, direction: 'to_node', agent_id: agentId, session_id: command.sid,
      task_id: 'taskId' in command ? command.taskId ?? null : null,
      directive_id: 'directiveId' in command ? command.directiveId ?? null : null,
      conversation_id: conversationId, seq, type: command.type, payload: JSON.stringify(frame), created_at: this.now(),
    });
    this.db.afterCommit(() => {
      try { this.options.deliver(agentId, frame); }
      catch (error) { this.options.onDeliveryError?.(error); } // Durable outbox is retried by the hub.
    });
    return frame;
  }
}
