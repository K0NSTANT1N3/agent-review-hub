import { useState } from 'react';
import type { TaskMode } from '@quorum/protocol';
import { call } from '../bridge';
import { Card, ErrorNote } from '../components/common';

export function NewTask({ onCreated }: { onCreated: (id: number) => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [priority, setPriority] = useState(1);
  const [mode, setMode] = useState<TaskMode>('own');
  const [requireApproval, setRequireApproval] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const t = await call('createTask', {
        body: {
          title,
          description,
          priority,
          mode,
          requireHumanApproval: requireApproval,
          tags: tags
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        },
      });
      onCreated(t.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="New task">
      <div className="form-grid">
        <label className="span-2">
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add rate limiting to the login endpoint" autoFocus />
        </label>
        <label className="span-2">
          What should be done?
          <textarea
            rows={10}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe the goal, constraints and how to verify it. Your agent writes it; a teammate's agent reviews it before it is merged."
          />
        </label>
        <label>
          Priority
          <select
            value={priority}
            onChange={(e) => {
              const p = Number(e.target.value);
              setPriority(p);
              // Urgent work defaults to a human approving the merge; it can still be unticked.
              if (p === 3) setRequireApproval(true);
            }}
          >
            <option value={0}>Low</option>
            <option value={1}>Normal</option>
            <option value={2}>High</option>
            <option value={3}>Urgent</option>
          </select>
        </label>
        <label>
          Who writes it
          <select value={mode} onChange={(e) => setMode(e.target.value as TaskMode)}>
            <option value="own">My agent</option>
            <option value="pool">Any available agent</option>
          </select>
        </label>
        <label className="span-2 row inline">
          <input type="checkbox" checked={requireApproval} onChange={(e) => setRequireApproval(e.target.checked)} />
          Require my approval before merge
          <span className="hint">(after the reviewer agent approves, the task waits for you instead of merging)</span>
        </label>
        <label className="span-2">
          Tags <span className="hint">(comma separated)</span>
          <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="backend, auth" />
        </label>
      </div>
      <ErrorNote error={error} />
      <div className="row">
        <button className="primary" disabled={busy || title.trim() === '' || description.trim() === ''} onClick={() => void submit()}>
          {busy ? 'Creating…' : 'Create task'}
        </button>
      </div>
    </Card>
  );
}
