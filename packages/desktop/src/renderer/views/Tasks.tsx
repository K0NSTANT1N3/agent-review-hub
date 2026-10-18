import { useEffect, useState } from 'react';
import type { TaskView } from '@quorum/protocol';
import { call, timeAgo, useLive } from '../bridge';
import { Empty, ErrorNote, StateBadge, WaitReasonNote } from '../components/common';
import {
  DEFAULT_QUERY,
  KANBAN_MIN_WIDTH,
  PRIORITY_LABEL,
  TASK_COLUMNS,
  buildBoard,
  pageSize,
  taskRole,
  type TaskBoardQuery,
  type TaskSort,
} from '../task-board';

export function Tasks({
  onOpen,
  mine,
  query,
  extra,
  onMine,
  onQuery,
  onExtra,
}: {
  onOpen: (id: number) => void;
  mine: boolean;
  query: TaskBoardQuery;
  extra: Record<string, number>;
  onMine: (mine: boolean) => void;
  onQuery: (query: TaskBoardQuery) => void;
  onExtra: (extra: Record<string, number>) => void;
}) {
  const width = useWindowWidth();
  const tasks = useLive(() => call('listTasks', { query: { mine: mine ? 'true' : 'false' } }), [mine], { events: ['task.updated'] });
  const model = buildBoard({ tasks: tasks.data?.tasks, query, extra, width });
  const filtersActive = mine || query.search !== '' || query.status !== 'all' || query.owner !== 'all' || query.priority !== 'all';

  return (
    <div className="stack">
      <div className="row">
        <h2 className="grow">Tasks</h2>
        <span className="badge">Sorted by {model.sortLabel}</span>
        <label className="row inline">
          <input type="checkbox" checked={mine} onChange={(e) => onMine(e.target.checked)} /> Only mine
        </label>
      </div>
      <div className="task-filters">
        <input
          aria-label="Search tasks"
          placeholder="Search title or ID"
          value={query.search}
          onChange={(e) => onQuery({ ...query, search: e.target.value })}
        />
        <select aria-label="Status" value={query.status} onChange={(e) => onQuery({ ...query, status: e.target.value })}>
          <option value="all">All statuses</option>
          {TASK_COLUMNS.map((col) => (
            <option key={col.title} value={col.title}>{col.title}</option>
          ))}
        </select>
        <select aria-label="Owner" value={query.owner} onChange={(e) => onQuery({ ...query, owner: e.target.value })}>
          <option value="all">All owners</option>
          {model.owners.map((owner) => (
            <option key={owner} value={owner}>{owner}</option>
          ))}
        </select>
        <select
          aria-label="Priority"
          value={query.priority === 'all' ? 'all' : String(query.priority)}
          onChange={(e) => onQuery({ ...query, priority: e.target.value === 'all' ? 'all' : Number(e.target.value) })}
        >
          <option value="all">All priorities</option>
          {PRIORITY_LABEL.map((label, priority) => (
            <option key={label} value={priority}>{label}</option>
          ))}
        </select>
        <select aria-label="Sort" value={query.sort} onChange={(e) => onQuery({ ...query, sort: e.target.value as TaskSort })}>
          <option value="updated">Recently updated</option>
          <option value="priority">Priority</option>
        </select>
        <button type="button" disabled={!filtersActive} onClick={() => { onMine(false); onQuery({ ...DEFAULT_QUERY, sort: query.sort }); }}>Clear filters</button>
      </div>
      <ErrorNote error={tasks.error} />
      {model.status === 'loading' && <Empty>Loading…</Empty>}
      {model.status === 'empty' && <Empty>No tasks yet.</Empty>}
      {model.status === 'no-results' && <Empty>No tasks match these filters.</Empty>}
      {model.status === 'ready' && (
        <div className={model.layout === 'list' ? 'board board-list' : 'board'}>
          {model.columns.map((col) => (
            <div className="column" key={col.title}>
              <h4>
                {col.title} <span className="muted">{col.total}</span>
              </h4>
              {col.total === 0 && <div className="muted small">—</div>}
              {col.visible.map((t) => (
                <TaskCard key={t.id} task={t} onOpen={onOpen} />
              ))}
              {col.hidden > 0 && (
                <button
                  type="button"
                  onClick={() => onExtra({ ...extra, [col.title]: (extra[col.title] ?? 0) + pageSize(col.title) })}
                >
                  Show {Math.min(pageSize(col.title), col.hidden)} more
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TaskCard({ task, onOpen }: { task: TaskView; onOpen: (id: number) => void }) {
  const role = taskRole(task.state);
  return (
    <button className="task-card" onClick={() => onOpen(task.id)}>
      <div className="row">
        <span className="muted">#{task.id}</span>
        <span className="grow" />
        <StateBadge state={task.state} />
      </div>
      <div className="task-title">{task.title}</div>
      <div className="muted small">
        {PRIORITY_LABEL[task.priority]}
        {role !== null ? ` · ${role}` : ''}
        {' · '}
        {task.requesterOwner} · round {task.reviewRound} · {timeAgo(task.updatedAt)}
      </div>
      <WaitReasonNote reason={task.waitReason} compact />
      {task.escalationReason !== null && <div className="small danger-text">{task.escalationReason}</div>}
    </button>
  );
}

function useWindowWidth(): number {
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? KANBAN_MIN_WIDTH : window.innerWidth));
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return width;
}
