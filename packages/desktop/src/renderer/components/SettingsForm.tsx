import type { AdapterConfig, LendMode } from '@quorum/protocol';
import { CLI_ADAPTER_TRUST_NOTE, isCliAdapter, settingsAdapter } from '../../shared/adapter-choice';
import type { DesktopSettings } from '../../shared/ipc';

const LEND_HELP: Record<LendMode, string> = {
  always: 'Teammates may use your agent whenever the app is running.',
  when_idle: 'Teammates may use your agent only while you are away from the keyboard.',
  never: 'Your agent only works on your own tasks.',
};

export function SettingsForm({ value, onChange }: { value: DesktopSettings; onChange: (v: DesktopSettings) => void }) {
  const set = <K extends keyof DesktopSettings>(key: K, v: DesktopSettings[K]) => onChange({ ...value, [key]: v });
  const adapter = value.adapter;
  const setAdapter = (a: AdapterConfig) => set('adapter', a);

  return (
    <div className="form-grid">
      <label>
        Coding agent
        <select
          value={adapter.type}
          onChange={(e) => setAdapter(settingsAdapter(e.target.value as AdapterConfig['type']))}
        >
          <option value="claude-code">Claude Code (recommended)</option>
          <option value="codex">Codex</option>
          <option value="pi">pi</option>
          <option value="omp">omp</option>
          <option value="kilo">Kilo Code</option>
          <option value="opencode">opencode server</option>
          <option value="mock">Mock (testing only)</option>
        </select>
      </label>

      {adapter.type === 'claude-code' && (
        <label>
          Model <span className="hint">(optional — empty uses your Claude Code default)</span>
          <input
            value={adapter.model ?? ''}
            placeholder="e.g. claude-opus-5-5"
            onChange={(e) => {
              const model = e.target.value.trim();
              setAdapter(model === '' ? { type: 'claude-code', contextWindow: adapter.contextWindow } : { ...adapter, model });
            }}
          />
        </label>
      )}
      {isCliAdapter(adapter) && (
        <>
          <label>
            Binary path <span className="hint">(optional — empty uses {adapter.type} on PATH)</span>
            <input
              value={adapter.binaryPath ?? ''}
              placeholder={adapter.type}
              onChange={(e) => {
                const binaryPath = e.target.value.trim();
                const next = { type: adapter.type, contextWindow: adapter.contextWindow, ...(adapter.model !== undefined ? { model: adapter.model } : {}) };
                setAdapter(binaryPath === '' ? next : { ...next, binaryPath });
              }}
            />
          </label>
          <label>
            Model <span className="hint">(optional)</span>
            <input
              value={adapter.model ?? ''}
              onChange={(e) => {
                const model = e.target.value.trim();
                const next = { type: adapter.type, contextWindow: adapter.contextWindow, ...(adapter.binaryPath !== undefined ? { binaryPath: adapter.binaryPath } : {}) };
                setAdapter(model === '' ? next : { ...next, model });
              }}
            />
          </label>
          <div className="note span-2">{CLI_ADAPTER_TRUST_NOTE[adapter.type]}</div>
        </>
      )}
      {adapter.type === 'opencode' && (
        <>
          <label>
            opencode server URL
            <input value={adapter.baseUrl} onChange={(e) => setAdapter({ ...adapter, baseUrl: e.target.value })} />
          </label>
          <label>
            Provider ID
            <input value={adapter.providerID} onChange={(e) => setAdapter({ ...adapter, providerID: e.target.value })} />
          </label>
          <label>
            Model ID
            <input value={adapter.modelID} onChange={(e) => setAdapter({ ...adapter, modelID: e.target.value })} />
          </label>
          <div className="note note-warn span-2">
            Quorum cannot restrict opencode's tools. Configure opencode's own permissions so reviewers stay read-only.
          </div>
        </>
      )}
      {adapter.type === 'mock' && (
        <label className="span-2">
          Mock script path
          <input value={adapter.scriptPath} onChange={(e) => setAdapter({ ...adapter, scriptPath: e.target.value })} />
        </label>
      )}

      <label>
        Lend my agent to teammates
        <select value={value.lendMode} onChange={(e) => set('lendMode', e.target.value as LendMode)}>
          <option value="when_idle">Only when I'm idle</option>
          <option value="always">Always</option>
          <option value="never">Never</option>
        </select>
        <span className="hint">{LEND_HELP[value.lendMode]}</span>
      </label>
      <label>
        Idle after (minutes)
        <input
          type="number"
          min={1}
          value={Math.round(value.idleThresholdSec / 60)}
          disabled={value.lendMode !== 'when_idle'}
          onChange={(e) => set('idleThresholdSec', Math.max(1, Number(e.target.value)) * 60)}
        />
      </label>
      <label>
        Daily token budget for teammates
        <input type="number" min={0} step={100000} value={value.lendTokensPerDay} onChange={(e) => set('lendTokensPerDay', Math.max(0, Number(e.target.value)))} />
      </label>
      <label>
        Parallel sessions
        <input type="number" min={1} max={8} value={value.maxSessions} onChange={(e) => set('maxSessions', Math.min(8, Math.max(1, Number(e.target.value))))} />
      </label>
      <label className="span-2">
        Expertise tags <span className="hint">(comma separated — helps the Leader pick reviewers)</span>
        <input
          value={value.tags.join(', ')}
          placeholder="frontend, go, database"
          onChange={(e) =>
            set(
              'tags',
              e.target.value
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean),
            )
          }
        />
      </label>
    </div>
  );
}
