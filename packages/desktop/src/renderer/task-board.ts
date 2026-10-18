import type { TaskState, TaskView } from '@quorum/protocol';

export const TASK_COLUMNS: { title: string; states: TaskState[] }[] = [
  { title: 'Queued', states: ['QUEUED'] },
  { title: 'Authoring', states: ['AUTHORING', 'SYNCING'] },
  { title: 'In review', states: ['AWAITING_REVIEWER', 'IN_REVIEW'] },
  { title: 'Merging', states: ['MERGE_QUEUED', 'MERGING'] },
  { title: 'Needs attention', states: ['ESCALATED', 'PAUSED'] },
  { title: 'Done', states: ['MERGED', 'CANCELLED', 'FAILED'] },
];

/** Active columns can show a larger first page; Done stays short so a long history does not freeze the board. */
export const ACTIVE_PAGE = 100;
export const DONE_PAGE = 30;
/** Below this viewport width the board stacks into one column instead of six. */
export const KANBAN_MIN_WIDTH = 1200;

export const PRIORITY_LABEL = ['Low', 'Normal', 'High', 'Urgent'] as const;

export type TaskSort = 'updated' | 'priority';

export interface TaskBoardQuery {
  search: string;
  /** Column title, or `all`. */
  status: string;
  /** Requester owner name, or `all`. */
  owner: string;
  priority: number | 'all';
  sort: TaskSort;
}

export const DEFAULT_QUERY: TaskBoardQuery = {
  search: '',
  status: 'all',
  owner: 'all',
  priority: 'all',
  sort: 'updated',
};

export function pageSize(columnTitle: string): number {
  return columnTitle === 'Done' ? DONE_PAGE : ACTIVE_PAGE;
}

export function layoutForWidth(width: number): 'kanban' | 'list' {
  return width >= KANBAN_MIN_WIDTH ? 'kanban' : 'list';
}

/** Role implied by the task state. Null when no agent is assigned yet or the task is waiting on a person. */
export function taskRole(state: TaskState): string | null {
  switch (state) {
    case 'AUTHORING':
    case 'SYNCING':
      return 'Author';
    case 'IN_REVIEW':
      return 'Reviewer';
    case 'AWAITING_REVIEWER':
      return null;
    case 'MERGE_QUEUED':
    case 'MERGING':
      return 'Merge';
    default:
      return null;
  }
}

export function sortLabel(sort: TaskSort): string {
  return sort === 'updated' ? 'recently updated' : 'priority';
}

function matchesSearch(task: TaskView, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (q === '') return true;
  if (task.title.toLowerCase().includes(q)) return true;
  const idQuery = q.startsWith('#') ? q.slice(1) : q;
  return idQuery !== '' && String(task.id).includes(idQuery);
}

export function filterTasks(tasks: readonly TaskView[], query: TaskBoardQuery): TaskView[] {
  const column = TASK_COLUMNS.find((col) => col.title === query.status);
  return tasks.filter((task) => {
    if (!matchesSearch(task, query.search)) return false;
    if (column !== undefined && !column.states.includes(task.state)) return false;
    if (query.owner !== 'all' && task.requesterOwner !== query.owner) return false;
    if (query.priority !== 'all' && task.priority !== query.priority) return false;
    return true;
  });
}

export function sortTasks(tasks: readonly TaskView[], sort: TaskSort): TaskView[] {
  return [...tasks].sort((a, b) => {
    if (sort === 'priority' && a.priority !== b.priority) return b.priority - a.priority;
    if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
    return b.id - a.id;
  });
}

export function ownerOptions(tasks: readonly TaskView[]): string[] {
  return [...new Set(tasks.map((task) => task.requesterOwner))].sort((a, b) => a.localeCompare(b));
}

export interface BoardColumn {
  title: string;
  total: number;
  visible: TaskView[];
  hidden: number;
}

export type BoardStatus = 'loading' | 'empty' | 'no-results' | 'ready';

export interface BoardModel {
  status: BoardStatus;
  layout: 'kanban' | 'list';
  sortLabel: string;
  columns: BoardColumn[];
  owners: string[];
  /** Id the card would open, or null when that task is not in the filtered board. */
  open: (id: number) => number | null;
}

export function buildBoard(args: {
  tasks: readonly TaskView[] | undefined;
  query: TaskBoardQuery;
  /** Extra rows revealed per column, on top of the first page. */
  extra: Readonly<Record<string, number>>;
  width: number;
}): BoardModel {
  const layout = layoutForWidth(args.width);
  const owners = args.tasks === undefined ? [] : ownerOptions(args.tasks);
  const base = {
    layout,
    sortLabel: sortLabel(args.query.sort),
    owners,
    columns: [] as BoardColumn[],
    open: () => null as number | null,
  };
  if (args.tasks === undefined) return { ...base, status: 'loading' };
  if (args.tasks.length === 0) return { ...base, status: 'empty' };

  const matched = sortTasks(filterTasks(args.tasks, args.query), args.query.sort);
  if (matched.length === 0) return { ...base, status: 'no-results' };

  const visibleIds = new Set<number>();
  const columns = TASK_COLUMNS.filter((col) => args.query.status === 'all' || col.title === args.query.status).map((col) => {
    const items = matched.filter((task) => col.states.includes(task.state));
    const limit = pageSize(col.title) + (args.extra[col.title] ?? 0);
    const visible = items.slice(0, limit);
    for (const task of visible) visibleIds.add(task.id);
    return { title: col.title, total: items.length, visible, hidden: Math.max(0, items.length - visible.length) };
  });

  return {
    status: 'ready',
    layout,
    sortLabel: sortLabel(args.query.sort),
    columns,
    owners,
    open: (id) => (visibleIds.has(id) ? id : null),
  };
}
