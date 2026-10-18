import { useEffect, useMemo, useState } from 'react';
import { html as diffHtml } from 'diff2html';
import 'diff2html/bundles/css/diff2html.min.css';
import { call } from '../bridge';

export interface DiffRange {
  label: string;
  from: string;
  to: string;
}

/** Renders `git diff from to` for a task. diff2html escapes file content before producing HTML. */
export function DiffView({ taskId, ranges }: { taskId: number; ranges: DiffRange[] }) {
  const [index, setIndex] = useState(0);
  const [view, setView] = useState<'line-by-line' | 'side-by-side'>('line-by-line');
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const range = ranges[Math.min(index, ranges.length - 1)];

  useEffect(() => {
    if (range === undefined) return;
    let live = true;
    setDiff(null);
    setError(null);
    call('getTaskDiff', { id: taskId, query: { from: range.from, to: range.to } })
      .then((r) => live && setDiff(r.diff))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [taskId, range?.from, range?.to]);

  // Hooks stay above any return. Skipping useMemo when there are no commits changes the hook count
  // once a commit arrives and React unmounts the whole window (error 310).
  const from = range?.from;
  const to = range?.to;
  const rendered = useMemo(
    () => (from !== undefined && to !== undefined && diff !== null && diff.trim() !== '' ? diffHtml(diff, { drawFileList: true, matching: diff.length > 200_000 ? 'none' : 'lines', outputFormat: view }) : null),
    [diff, view, from, to],
  );
  if (range === undefined) return <div className="empty">No commits yet.</div>;
  return (
    <div>
      <div className="row diff-toolbar">
        <select value={index} onChange={(e) => setIndex(Number(e.target.value))}>
          {ranges.map((r, i) => (
            <option key={`${r.from}-${r.to}`} value={i}>
              {r.label}
            </option>
          ))}
        </select>
        <select value={view} onChange={(e) => setView(e.target.value as typeof view)}>
          <option value="line-by-line">Unified</option>
          <option value="side-by-side">Side by side</option>
        </select>
        <code className="muted">
          {range.from.slice(0, 7)}..{range.to.slice(0, 7)}
        </code>
      </div>
      {error !== null && <div className="note note-danger">{error}</div>}
      {diff === null && error === null && <div className="empty">Loading diff…</div>}
      {diff !== null && diff.trim() === '' && <div className="empty">No changes in this range.</div>}
      {rendered !== null && <div className="diff" dangerouslySetInnerHTML={{ __html: rendered }} />}
    </div>
  );
}
