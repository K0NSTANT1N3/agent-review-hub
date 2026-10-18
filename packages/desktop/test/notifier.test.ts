import { describe, expect, it } from 'vitest';
import type { TaskView, UiEvent } from '@quorum/protocol';
import type { AppState } from '../src/shared/ipc.js';
import { createNotifier } from '../src/main/notifier.js';

const me = { ownerName: 'Ana', agentId: 'ana-agent' } as AppState;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function task(id: number, state: TaskView['state'], requesterOwner: string): UiEvent {
  return { type: 'task.updated', data: { id, title: `T${id}`, state, requesterOwner, escalationReason: 'stuck' } as TaskView };
}

function attention(taskId: number, reason: 'no_reviewer' | 'author_unavailable' | 'escalated'): UiEvent {
  return { type: 'task.needs_attention', data: { taskId, reason, message: `m${taskId}` } };
}

function setup(owners: Record<number, string> = {}) {
  const shown: string[] = [];
  const looked: number[] = [];
  const notify = createNotifier({
    show: (title) => shown.push(title),
    requesterOf: async (id) => {
      looked.push(id);
      return owners[id] ?? null;
    },
  });
  return { notify: (e: UiEvent) => notify(e, me), shown, looked };
}

describe('notifier', () => {
  it('notifies needs_attention only for the user own tasks', async () => {
    const { notify, shown, looked } = setup({ 3: 'Ana', 4: 'Bo' });
    notify(task(1, 'IN_REVIEW', 'Bo'));
    notify(attention(1, 'no_reviewer'));
    notify(task(2, 'IN_REVIEW', 'Ana'));
    notify(attention(2, 'no_reviewer'));
    notify(attention(3, 'author_unavailable'));
    notify(attention(4, 'author_unavailable'));
    await flush();
    expect(shown).toEqual(['Task #2 needs attention', 'Task #3 needs attention']);
    expect(looked).toEqual([3, 4]);
  });

  it('notifies an escalation once whichever event arrives first', async () => {
    const { notify, shown } = setup({ 6: 'Ana' });
    notify(task(5, 'IN_REVIEW', 'Ana'));
    notify(task(5, 'ESCALATED', 'Ana'));
    notify(attention(5, 'escalated'));
    expect(shown).toEqual(['Needs your decision']);

    notify(task(6, 'IN_REVIEW', 'Ana'));
    notify(attention(6, 'escalated'));
    notify(task(6, 'ESCALATED', 'Ana'));
    await flush();
    expect(shown).toEqual(['Needs your decision', 'Task #6 needs attention']);

    // A second escalation after the task resumed notifies again.
    notify(task(6, 'IN_REVIEW', 'Ana'));
    notify(task(6, 'ESCALATED', 'Ana'));
    expect(shown.length).toBe(3);
  });
});
