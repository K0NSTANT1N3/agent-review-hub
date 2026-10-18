import { describe, expect, it } from 'vitest';
import type { TaskState, TaskView } from '@quorum/protocol';
import { DEFAULT_QUERY, DONE_PAGE, buildBoard, layoutForWidth, taskRole, type TaskBoardQuery } from '../src/renderer/task-board.js';

function task(partial: Partial<TaskView> & Pick<TaskView, 'id' | 'title' | 'state'>): TaskView {
  return {
    description: '',
    tags: [],
    priority: 1,
    mode: 'own',
    requesterAgentId: 'agent-a',
    requesterOwner: 'ada',
    authorAgentId: null,
    authorSessionId: null,
    waitReason: null,
    pausedFromState: null,
    pauseReason: null,
    escalationReason: null,
    branch: null,
    baseCommit: null,
    headCommit: null,
    lastReviewedCommit: null,
    reviewRound: 1,
    testFixAttempts: 0,
    syncAttempts: 0,
    files: [],
    diffLines: 0,
    lastTestOutput: null,
    mergedCommit: null,
    createdAt: 1,
    updatedAt: partial.id * 1_000,
    stateEnteredAt: 1,
    approvedAt: null,
    ...partial,
  };
}

function board(tasks: TaskView[], query: Partial<TaskBoardQuery> = {}, extra: Record<string, number> = {}, width = 1400) {
  return buildBoard({ tasks, query: { ...DEFAULT_QUERY, ...query }, extra, width });
}

describe('task board search, filters, and sort', () => {
  const tasks = [
    task({ id: 12, title: 'Fix auth redirect', state: 'QUEUED', requesterOwner: 'ada', priority: 3, updatedAt: 500 }),
    task({ id: 4, title: 'Document deploy', state: 'IN_REVIEW', requesterOwner: 'grace', priority: 1, updatedAt: 800 }),
    task({ id: 9, title: 'Auth token refresh', state: 'MERGED', requesterOwner: 'ada', priority: 2, updatedAt: 100 }),
  ];

  it('finds a task by title or id and combines that with status, owner, and priority', () => {
    expect(board(tasks, { search: 'AUTH' }).columns.flatMap((col) => col.visible).map((t) => t.id)).toEqual([12, 9]);
    expect(board(tasks, { search: '#4' }).open(4)).toBe(4);
    expect(board(tasks, { search: '12' }).open(12)).toBe(12);

    const combined = board(tasks, { search: 'auth', status: 'Queued', owner: 'ada', priority: 3 });
    expect(combined.columns.map((col) => col.title)).toEqual(['Queued']);
    expect(combined.open(12)).toBe(12);
    expect(combined.open(9)).toBeNull();
  });

  it('restores the full list when filters return to the default query', () => {
    const narrowed = board(tasks, { search: 'missing', status: 'Done', owner: 'grace', priority: 0 });
    expect(narrowed.status).toBe('no-results');
    const cleared = board(tasks, DEFAULT_QUERY);
    expect(cleared.status).toBe('ready');
    expect(cleared.columns.flatMap((col) => col.visible).map((t) => t.id).sort((a, b) => a - b)).toEqual([4, 9, 12]);
  });

  it('sorts deterministically and keeps the active sort label', () => {
    const sameTime = [
      task({ id: 2, title: 'a', state: 'QUEUED', updatedAt: 50, priority: 1 }),
      task({ id: 5, title: 'b', state: 'QUEUED', updatedAt: 50, priority: 3 }),
      task({ id: 3, title: 'c', state: 'QUEUED', updatedAt: 10, priority: 3 }),
    ];
    expect(board(sameTime, { sort: 'updated' }).columns[0]!.visible.map((t) => t.id)).toEqual([5, 2, 3]);
    expect(board(sameTime, { sort: 'updated' }).sortLabel).toBe('recently updated');
    expect(board(sameTime, { sort: 'priority' }).columns[0]!.visible.map((t) => t.id)).toEqual([5, 3, 2]);
    expect(board(sameTime, { sort: 'priority' }).sortLabel).toBe('priority');
  });

  it('keeps the same filter when a later snapshot arrives', () => {
    const query = { search: 'auth', owner: 'ada' };
    const first = board(tasks, query).columns.flatMap((col) => col.visible).map((t) => t.id);
    const next = board([...tasks, task({ id: 20, title: 'Auth cache', state: 'AUTHORING', requesterOwner: 'ada' })], query);
    expect(first).toEqual([12, 9]);
    expect(next.columns.flatMap((col) => col.visible).map((t) => t.id)).toEqual([12, 20, 9]);
    expect(next.columns.find((col) => col.title === 'Authoring')!.visible.map((t) => t.id)).toEqual([20]);
    expect(next.open(20)).toBe(20);
  });
});

describe('task board layout and completed tasks', () => {
  it('labels an in-review task as reviewer work and a task still waiting as unassigned', () => {
    expect(taskRole('IN_REVIEW')).toBe('Reviewer');
    expect(taskRole('AWAITING_REVIEWER')).toBeNull();
    expect(taskRole('AUTHORING')).toBe('Author');
  });

  it('uses one column below the kanban width and six columns at and above it', () => {
    expect(layoutForWidth(1199)).toBe('list');
    expect(layoutForWidth(1200)).toBe('kanban');
    expect(board([task({ id: 1, title: 'a', state: 'QUEUED' })], {}, {}, 800).layout).toBe('list');
    expect(board([task({ id: 1, title: 'a', state: 'QUEUED' })], {}, {}, 1200).layout).toBe('kanban');
  });

  it('keeps completed tasks past the first page discoverable', () => {
    const done = Array.from({ length: 45 }, (_, i) => task({ id: i + 1, title: `done ${i + 1}`, state: 'MERGED' as TaskState }));
    const first = board(done);
    const column = first.columns.find((col) => col.title === 'Done')!;
    expect(column.visible).toHaveLength(DONE_PAGE);
    expect(column.hidden).toBe(15);
    expect(first.open(1)).toBeNull();
    const more = board(done, {}, { Done: 30 });
    const rest = more.columns.find((col) => col.title === 'Done')!;
    expect(rest.hidden).toBe(0);
    expect(rest.visible).toHaveLength(45);
    expect(more.open(1)).toBe(1);
  });

  it('distinguishes loading, empty, and no-results', () => {
    expect(buildBoard({ tasks: undefined, query: DEFAULT_QUERY, extra: {}, width: 1400 }).status).toBe('loading');
    expect(board([]).status).toBe('empty');
    expect(board([task({ id: 1, title: 'a', state: 'QUEUED' })], { search: 'nope' }).status).toBe('no-results');
  });
});
