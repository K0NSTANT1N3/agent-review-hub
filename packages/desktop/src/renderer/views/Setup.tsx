import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, type DesktopSettings } from '../../shared/ipc';
import { bridge } from '../bridge';
import { ErrorNote } from '../components/common';
import { SettingsForm } from '../components/SettingsForm';

export function Setup() {
  const [mode, setMode] = useState<'host' | 'join' | null>(null);
  const [settings, setSettings] = useState<DesktopSettings>(DEFAULT_SETTINGS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // host
  const [ownerName, setOwnerName] = useState('');
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('main');
  const [port, setPort] = useState(7420);
  const [addresses, setAddresses] = useState<string[]>([]);
  const [publicHost, setPublicHost] = useState('');
  // join
  const [joinCode, setJoinCode] = useState('');

  useEffect(() => {
    void bridge()
      .networkAddresses()
      .then((a) => {
        setAddresses(a);
        setPublicHost((p) => p || (a[0] ?? '127.0.0.1'));
      });
  }, []);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'host') await bridge().setupHost({ ownerName, repoRemoteUrl: repo, mainBranch: branch, port, publicHost, settings });
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
          <label className="span-2">
            Address teammates use to reach this computer
            <input list="addresses" value={publicHost} onChange={(e) => setPublicHost(e.target.value)} placeholder="192.168.1.20 or https://name.trycloudflare.com" />
            <datalist id="addresses">
              {addresses.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
            <span className="hint">
              Same Wi-Fi/office: use this computer's IP. Teammates elsewhere: paste a tunnel URL (e.g. from{' '}
              <code>cloudflared tunnel --url http://localhost:{port}</code>) for an encrypted link with no VPN or router changes, or use a VPN
              such as Tailscale. See the install guide.
            </span>
          </label>
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
