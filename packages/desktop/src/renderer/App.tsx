import { useEffect, useState } from 'react';
import type { AppState } from '../shared/ipc';
import { bridge } from './bridge';
import { Dot } from './components/common';
import { Logo } from './components/Logo';
import { Dashboard } from './views/Dashboard';
import { NewTask } from './views/NewTask';
import { Directives, Sessions, Settings, Team } from './views/Others';
import { Setup } from './views/Setup';
import { TaskDetail } from './views/TaskDetail';
import { Tasks } from './views/Tasks';

type Page = { name: 'dashboard' } | { name: 'tasks' } | { name: 'task'; id: number } | { name: 'new' } | { name: 'directives' } | { name: 'sessions' } | { name: 'team' } | { name: 'settings' };

const NAV: { page: Page['name']; label: string }[] = [
  { page: 'dashboard', label: 'Dashboard' },
  { page: 'tasks', label: 'Tasks' },
  { page: 'new', label: 'New task' },
  { page: 'directives', label: 'Ask an agent' },
  { page: 'sessions', label: 'Sessions' },
  { page: 'team', label: 'Team' },
  { page: 'settings', label: 'Settings' },
];

/** Optional start page from the URL hash, e.g. "#tasks" or "#task=3&tab=diff". */
function initialPage(): { page: Page; tab: string | null } {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const task = Number(params.get('task'));
  if (Number.isInteger(task) && task > 0) return { page: { name: 'task', id: task }, tab: params.get('tab') };
  const name = [...params.keys()][0] as Page['name'] | undefined;
  const known = NAV.some((n) => n.page === name);
  return { page: known ? ({ name } as Page) : { name: 'dashboard' }, tab: null };
}

const START = initialPage();

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [page, setPage] = useState<Page>(START.page);

  useEffect(() => {
    void bridge().getState().then(setState);
    return bridge().onState(setState);
  }, []);

  if (state === null) return <div className="splash">Starting Quorum…</div>;
  if (!state.configured) return <Setup />;

  const active = page.name === 'task' ? 'tasks' : page.name;
  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">
          <Logo size={24} />
          Quorum
        </div>
        {NAV.map((n) => (
          <button key={n.page} className={active === n.page ? 'nav active' : 'nav'} onClick={() => setPage({ name: n.page } as Page)}>
            {n.label}
          </button>
        ))}
        <div className="grow" />
        <div className="status small">
          <div>
            <Dot tone={state.connected ? 'ok' : 'warn'} /> {state.connected ? 'connected' : 'connecting…'}
          </div>
          <div>
            <Dot tone={state.node.running ? 'ok' : 'danger'} /> agent {state.node.running ? (state.settings?.paused ? 'paused' : 'running') : 'stopped'}
          </div>
          <div className="muted">{state.ownerName}</div>
        </div>
      </nav>
      <main className="content">
        {page.name === 'dashboard' && <Dashboard state={state} onOpenTask={(id) => setPage({ name: 'task', id })} />}
        {page.name === 'tasks' && <Tasks onOpen={(id) => setPage({ name: 'task', id })} />}
        {page.name === 'task' && <TaskDetail id={page.id} state={state} initialTab={START.tab} onBack={() => setPage({ name: 'tasks' })} />}
        {page.name === 'new' && <NewTask onCreated={(id) => setPage({ name: 'task', id })} />}
        {page.name === 'directives' && <Directives state={state} />}
        {page.name === 'sessions' && <Sessions state={state} />}
        {page.name === 'team' && <Team state={state} />}
        {page.name === 'settings' && <Settings state={state} />}
      </main>
    </div>
  );
}
