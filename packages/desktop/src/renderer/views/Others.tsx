import { useEffect, useState } from 'react';
import type { DirectiveView } from '@quorum/protocol';
import type { AppState, DesktopSettings } from '../../shared/ipc';
import { bridge, call, formatTokens, onUiEvent, timeAgo, useLive } from '../bridge';
import { Bar, Card, Empty, ErrorNote } from '../components/common';
import { SettingsForm } from '../components/SettingsForm';

// ---------------------------------------------------------------------------
// Directives — ask any agent a question (read-only)
// ---------------------------------------------------------------------------

const DIRECTIVES_KEY = 'quorum.directives';

function storedDirectiveIds(): string[] {
  try {
    return JSON.parse(localStorage.getItem(DIRECTIVES_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
}

export function Directives({ state }: { state: AppState }) {
  const agents = useLive(() => call('listAgents'), []);
  const [agentId, setAgentId] = useState(state.agentId ?? '');
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<DirectiveView[]>([]);

  const refresh = async () => {
    const ids = storedDirectiveIds();
    const loaded = await Promise.all(ids.map((id) => call('getDirective', { id }).catch(() => null)));
    setItems(loaded.filter((d): d is DirectiveView => d !== null));
  };

  useEffect(() => {
    void refresh();
    const off = onUiEvent((e) => {
      if (e.type === 'directive.updated') void refresh();
    });
    const t = setInterval(() => void refresh(), 5000);
    return () => {
      off();
      clearInterval(t);
    };
  }, []);

  const send = async () => {
    setError(null);
    try {
      const d = await call('createDirective', { body: { agentId, text } });
      localStorage.setItem(DIRECTIVES_KEY, JSON.stringify([d.id, ...storedDirectiveIds()].slice(0, 50)));
      setText('');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="stack">
      <Card title="Ask an agent">
        <p className="muted">Directives are read-only questions (the agent can read the repository but not change it). To change code, create a task.</p>
        <div className="form-grid">
          <label>
            Agent
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              {(agents.data?.agents ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.id} ({a.ownerName}){a.status !== 'online' ? ' — offline' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="span-2">
            Question
            <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="Where is the retry logic for payments implemented?" />
          </label>
        </div>
        <ErrorNote error={error} />
        <button className="primary" disabled={text.trim() === '' || agentId === ''} onClick={() => void send()}>
          Send
        </button>
      </Card>
      {items.length === 0 ? (
        <Empty>No directives yet.</Empty>
      ) : (
        items.map((d) => (
          <Card key={d.id} title={`${d.agentId} · ${d.state}`} actions={<span className="muted">{timeAgo(d.createdAt)}</span>}>
            <blockquote>{d.text}</blockquote>
            {d.resultText !== null && <pre className="prewrap">{d.resultText}</pre>}
            {d.error !== null && <ErrorNote error={d.error} />}
          </Card>
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sessions — my agent's chats and what they are locked to
// ---------------------------------------------------------------------------

export function Sessions({ state }: { state: AppState }) {
  const sessions = useLive(() => call('listSessions', { query: state.agentId ? { agentId: state.agentId } : {} }), [state.agentId], {
    events: ['session.updated', 'task.updated'],
    pollMs: 5000,
  });
  const window = state.settings?.adapter.contextWindow ?? 200000;
  return (
    <Card title="My agent's sessions">
      <ErrorNote error={sessions.error} />
      {sessions.data === undefined || sessions.data.sessions.length === 0 ? (
        <Empty>No open sessions.</Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Session</th>
              <th>State</th>
              <th>Working on</th>
              <th>Context used</th>
              <th>Last used</th>
            </tr>
          </thead>
          <tbody>
            {sessions.data.sessions.map((s) => (
              <tr key={s.id}>
                <td>
                  <code>{s.id.slice(0, 8)}</code>
                </td>
                <td>{s.state}</td>
                <td>{s.lockKind === null ? '—' : `${s.lockRole} of ${s.lockKind} ${s.lockKind === 'task' ? '#' : ''}${s.lockRef}`}</td>
                <td style={{ minWidth: 160 }}>
                  <Bar value={s.contextTokens} max={window} tone={s.contextTokens > window * 0.75 ? 'warn' : 'info'} />
                  <span className="hint">{formatTokens(s.contextTokens)}</span>
                </td>
                <td>{timeAgo(s.lastUsedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Team — host invites teammates
// ---------------------------------------------------------------------------

export function Team({ state }: { state: AppState }) {
  const agents = useLive(() => call('listAgents'), [], { events: ['agent.updated'] });
  const [name, setName] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const invite = async () => {
    setError(null);
    setCopied(false);
    try {
      const r = await bridge().invite({ agentId: '', ownerName: name });
      setCode(r.joinCode);
      agents.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));
    }
  };

  return (
    <div className="stack">
      {state.isAdmin ? (
        <Card title="Invite a teammate">
          <p className="muted">
            Creates an agent for them and a join code with a secret token. Send it privately; they paste it into “Join a team”. Inviting the same name again rotates their token.
          </p>
          <div className="row">
            <input className="grow" value={name} onChange={(e) => setName(e.target.value)} placeholder="Teammate's name" />
            <button className="primary" disabled={name.trim() === ''} onClick={() => void invite()}>
              Create join code
            </button>
          </div>
          <ErrorNote error={error} />
          {code !== null && (
            <div className="stack-sm">
              <textarea readOnly rows={3} value={code} onFocus={(e) => e.currentTarget.select()} />
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(code).then(() => setCopied(true));
                }}
              >
                {copied ? 'Copied ✓' : 'Copy'}
              </button>
            </div>
          )}
          <p className="hint">
            Teammates connect to <code>{state.leader?.publicUrl}</code>
            {state.leader?.restrictedTo ? <> (only connections through {state.leader.restrictedTo} are accepted)</> : null}.{' '}
            {state.encrypted
              ? 'The connection is encrypted.'
              : 'This connection is not encrypted: fine on the same network or a VPN; for teammates on the internet use a tunnel URL (Settings → Disconnect, then host again with the tunnel address).'}
          </p>
        </Card>
      ) : (
        <Card title="Team">
          <p className="muted">Ask your team's host to invite new teammates.</p>
        </Card>
      )}
      <Card title="Members">
        {(agents.data?.agents ?? []).map((a) => (
          <div key={a.id} className="row member">
            <strong>{a.ownerName}</strong>
            <code>{a.id}</code>
            <span className="grow" />
            <span className="muted">{a.status}</span>
          </div>
        ))}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function Settings({ state }: { state: AppState }) {
  const [draft, setDraft] = useState<DesktopSettings | null>(state.settings);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [check, setCheck] = useState<{ ok: boolean; detail: string } | null>(null);
  if (draft === null) return null;

  const save = async () => {
    setError(null);
    try {
      await bridge().updateSettings(draft);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const reset = async () => {
    if (!window.confirm('Disconnect this computer from the team? You will need a new join code (or to host again).')) return;
    await bridge().reset();
  };

  return (
    <div className="stack">
      <Card title="My agent">
        <SettingsForm value={draft} onChange={setDraft} />
        <ErrorNote error={error} />
        <div className="row">
          <button className="primary" onClick={() => void save()}>
            {saved ? 'Saved ✓' : 'Save'}
          </button>
          <button onClick={() => void bridge().checkAgent().then(setCheck)}>Check agent</button>
        </div>
        {check !== null && <div className={check.ok ? 'note note-ok' : 'note note-danger'}>{check.detail}</div>}
      </Card>
      <CliAccess state={state} />
      <Card title="This computer">
        <p>
          Signed in as <strong>{state.ownerName}</strong> (<code>{state.agentId}</code>) · {state.mode === 'host' ? 'hosting the Leader' : 'member'}
        </p>
        <p className="muted">
          Repository <code>{state.repoRemoteUrl}</code>
        </p>
        <p className="muted">
          Data folder <code>{state.dataDir}</code>
        </p>
        <button className="danger" onClick={() => void reset()}>
          Disconnect this computer
        </button>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent CLI access — requester-scope tokens for the `quorum` CLI
// ---------------------------------------------------------------------------

function CliAccess({ state }: { state: AppState }) {
  const tokens = useLive(() => call('listApiTokens'), [], { pollMs: 30_000 });
  const [label, setLabel] = useState('');
  const [created, setCreated] = useState<{ token: string; label: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setError(null);
    setCopied(false);
    try {
      const t = await call('createApiToken', { body: { label: label.trim() || 'quorum CLI' } });
      setCreated({ token: t.token, label: t.label });
      setLabel('');
      tokens.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const revoke = async (id: string) => {
    if (!window.confirm('Revoke this token? Scripts and agents using it stop working.')) return;
    try {
      await call('revokeApiToken', { id });
      tokens.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const login = created === null ? '' : `quorum login --url ${state.apiUrl ?? '<leader url>'} --token ${created.token}`;
  const live = (tokens.data?.tokens ?? []).filter((t) => t.revokedAt === null);

  return (
    <Card title="Agent CLI access">
      <p className="muted">
        Let a coding agent or script use Quorum as you through the <code>quorum</code> CLI: create tasks, wait for them, read diffs, answer a blocked author and
        ask agents. CLI tokens can never approve, send back, cancel or merge. Those stay in this app.
      </p>
      <div className="row">
        <input className="grow" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label, e.g. Claude Code on my laptop" />
        <button className="primary" onClick={() => void create()}>
          Create CLI token
        </button>
      </div>
      <ErrorNote error={error ?? tokens.error} />
      {created !== null && (
        <div className="stack-sm">
          <div className="note note-warn">Copy this now. The token is shown only once and works like a password.</div>
          <textarea readOnly rows={2} value={login} onFocus={(e) => e.currentTarget.select()} />
          <button onClick={() => void navigator.clipboard.writeText(login).then(() => setCopied(true))}>{copied ? 'Copied ✓' : 'Copy login command'}</button>
        </div>
      )}
      {live.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Label</th>
              <th>Created</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {live.map((t) => (
              <tr key={t.id}>
                <td>{t.label || <span className="muted">unnamed</span>}</td>
                <td>{timeAgo(t.createdAt)}</td>
                <td>{timeAgo(t.lastUsedAt)}</td>
                <td>
                  <button className="danger" onClick={() => void revoke(t.id)}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
