import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, type AddressOption, type DesktopSettings } from '../../shared/ipc';
import { bridge } from '../bridge';
import { ErrorNote } from '../components/common';
import { Logo } from '../components/Logo';
import { SettingsForm } from '../components/SettingsForm';

export function Setup() {
  const [mode, setMode] = useState<'host' | 'join' | null>(() => {
    const start = new URLSearchParams(window.location.hash.slice(1)).get('setup');
    return start === 'host' || start === 'join' ? start : null;
  });
  const [settings, setSettings] = useState<DesktopSettings>(DEFAULT_SETTINGS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // host
  const [ownerName, setOwnerName] = useState('');
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('main');
  const [port, setPort] = useState(7420);
  const [addresses, setAddresses] = useState<AddressOption[]>([]);
  /** Index into `addresses`, or -1 for a custom address. */
  const [choice, setChoice] = useState(-1);
  const [custom, setCustom] = useState('');
  const [restrict, setRestrict] = useState(false);
  // join
  const [joinCode, setJoinCode] = useState('');

  useEffect(() => {
    void bridge()
      .networkAddresses()
      .then((a) => {
        setAddresses(a);
        // Teammates on other computers need an https:// address (TLS proxy or tunnel); plain addresses only carry
        // credentials on this computer, so the tunnel option is the default.
        setChoice(-1);
        setRestrict(false);
      });
  }, []);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'host') {
        const picked = choice >= 0 ? addresses[choice] : undefined;
        await bridge().setupHost({
          ownerName,
          repoRemoteUrl: repo,
          mainBranch: branch,
          port,
          publicHost: picked?.address ?? custom,
          restrictToIp: picked !== undefined && restrict ? picked.bindIp : null,
          settings,
        });
      }
      else await bridge().setupJoin({ joinCode, settings });
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (mode === null) {
    return (
      <div className="setup">
        <Logo size={64} />
        <h1>Welcome to Quorum</h1>
        <p className="lead">
          Your coding agent writes code; a teammate's agent reviews it; the Leader merges it once it is approved.
        </p>
        <div className="choice-grid">
          <button className="choice" onClick={() => setMode('host')}>
            <strong>Host a team</strong>
            <span>Run the Leader on this computer and invite teammates. Choose this on one machine per team.</span>
          </button>
          <button className="choice" onClick={() => setMode('join')}>
            <strong>Join a team</strong>
            <span>Paste the join code your host sent you.</span>
          </button>
        </div>
        <p className="hint">You need Git access to the team repository and a logged-in Claude Code (run <code>claude</code> once) on this computer.</p>
      </div>
    );
  }

  return (
    <div className="setup">
      <button className="link" onClick={() => setMode(null)}>
        ← Back
      </button>
      <h1>{mode === 'host' ? 'Host a team' : 'Join a team'}</h1>
      {mode === 'host' ? (
        <div className="form-grid">
          <label>
            Your name
            <input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} placeholder="Ana" autoFocus />
          </label>
          <label>
            Team repository (git URL)
            <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="git@github.com:team/project.git" />
          </label>
          <label>
            Main branch
            <input value={branch} onChange={(e) => setBranch(e.target.value)} />
          </label>
          <label>
            Leader port
            <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
          </label>
          <div className="span-2 stack-sm">
            <strong>Address teammates use to reach this computer</strong>
            <span className="hint">
              It goes into every join code. Teammates on other computers need an https:// address, so their tokens travel
              encrypted: a TLS proxy or a tunnel such as <code>cloudflared tunnel --url http://localhost:{port}</code>.
              This applies on a LAN and on a VPN too.
            </span>
            <label className="radio">
              <input type="radio" checked={choice === -1} onChange={() => setChoice(-1)} />
              https:// tunnel or TLS proxy URL
              <span className="tag">needed for teammates</span>
              {choice === -1 && (
                <input className="grow" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="https://name.trycloudflare.com" />
              )}
            </label>
            {addresses.length > 0 && <span className="hint">Plain addresses (no TLS): only for an agent on this computer. Teammates cannot join through them.</span>}
            {addresses.map((o, i) => (
              <label key={`${o.address}-${o.interfaceName}`} className="radio">
                <input type="radio" checked={choice === i} onChange={() => setChoice(i)} />
                <code>{o.address}</code>
                <span className="badge badge-muted">{o.label}</span>
              </label>
            ))}
            <label className="radio">
              <input type="checkbox" checked={restrict && choice >= 0} disabled={choice < 0} onChange={(e) => setRestrict(e.target.checked)} />
              Only accept connections through this address
              <span className="hint">(other networks this computer joins cannot reach the Leader)</span>
            </label>
          </div>
        </div>
      ) : (
        <div className="form-grid">
          <label className="span-2">
            Join code
            <textarea rows={4} value={joinCode} onChange={(e) => setJoinCode(e.target.value)} placeholder="quorum1.…" autoFocus />
            <span className="hint">The code contains a secret token. Ask your host for a new one if it leaked.</span>
          </label>
        </div>
      )}
      <h2>Your agent</h2>
      <SettingsForm value={settings} onChange={setSettings} />
      <ErrorNote error={error} />
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => void submit()}>
          {busy ? 'Starting…' : mode === 'host' ? 'Start hosting' : 'Join team'}
        </button>
      </div>
    </div>
  );
}
