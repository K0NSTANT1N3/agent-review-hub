import type { AppState } from '../../shared/ipc';
import { bridge, call, formatTokens, timeAgo, useLive } from '../bridge';
import { Bar, Card, Dot, Empty, ErrorNote } from '../components/common';

export function Dashboard({ state }: { state: AppState }) {
  const agents = useLive(() => call('listAgents'), [], { events: ['agent.updated', 'session.updated'], pollMs: 10_000 });
  const tasks = useLive(() => call('listTasks', { query: { mine: 'true' } }), [], { events: ['task.updated'] });
  const settings = state.settings;

  const togglePause = async () => {
    if (settings === null) return;
    await bridge().updateSettings({ ...settings, paused: !settings.paused });
  };

  const open = (tasks.data?.tasks ?? []).filter((t) => !['MERGED', 'CANCELLED', 'FAILED'].includes(t.state));
  const attention = open.filter((t) => t.state === 'ESCALATED' || t.state === 'PAUSED');

  return (
    <div className="stack">
      <div className="grid-3">
        <Card title="This computer">
          {state.leader !== null && (
            <p>
              <Dot tone={state.leader.running ? 'ok' : 'danger'} /> Leader {state.leader.running ? `running on port ${state.leader.port}` : 'stopped'}
            </p>
          )}
          <ErrorNote error={state.leader?.error} />
          <p>
            <Dot tone={state.node.running ? 'ok' : 'danger'} /> Agent {state.node.running ? 'running' : 'stopped'}
            {settings?.paused ? ' (paused)' : ''}
          </p>
          <ErrorNote error={state.node.error} />
          <p>
            <Dot tone={state.connected ? 'ok' : 'warn'} /> {state.connected ? 'Connected to the Leader' : 'Connecting to the Leader…'}
          </p>
          <div className="row">
            <button onClick={() => void togglePause()}>{settings?.paused ? 'Resume my agent' : 'Pause my agent'}</button>
            <button onClick={() => void bridge().restart()}>Restart</button>
          </div>
        </Card>
        <Card title="My open tasks">
          <p className="big">{open.length}</p>
          <p className="muted">{attention.length > 0 ? `${attention.length} need your attention` : 'Nothing needs you right now'}</p>
        </Card>
        <Card title="Lending">
          <p>
            Mode: <strong>{settings?.lendMode === 'when_idle' ? 'when idle' : settings?.lendMode}</strong>
          </p>
          <p className="muted">Budget for teammates: {formatTokens(settings?.lendTokensPerDay ?? 0)} tokens / day</p>
        </Card>
      </div>

      <Card title="Team agents">
        <ErrorNote error={agents.error} />
        {agents.data === undefined ? (
          <Empty>Loading…</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Agent</th>
                <th>Owner</th>
                <th>Status</th>
                <th>Sessions</th>
                <th>Lent today</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {agents.data.agents.map((a) => {
                const limited = a.rateLimitedUntil !== null && a.rateLimitedUntil > Date.now();
                const tone = a.status !== 'online' ? 'muted' : limited || a.paused ? 'warn' : 'ok';
                return (
                  <tr key={a.id}>
                    <td>
                      {a.id}
                      {a.id === state.agentId && <span className="tag">you</span>}
                    </td>
                    <td>{a.ownerName}</td>
                    <td>
                      <Dot tone={tone} />{' '}
                      {a.status !== 'online' ? 'offline' : limited ? `rate-limited until ${new Date(a.rateLimitedUntil!).toLocaleTimeString()}` : a.paused ? 'paused' : a.lendMode === 'never' ? 'own work only' : 'available'}
                    </td>
                    <td>
                      {a.lockedSessions}/{a.maxSessions} busy
                    </td>
                    <td style={{ minWidth: 140 }}>
                      <Bar value={a.lentToday} max={Math.max(1, a.lendTokensPerDay)} tone={a.budgetRemaining <= 0 ? 'danger' : 'info'} />
                      <span className="hint">
                        {formatTokens(a.lentToday)} / {formatTokens(a.lendTokensPerDay)}
                      </span>
                    </td>
                    <td>{timeAgo(a.lastHeartbeatAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
