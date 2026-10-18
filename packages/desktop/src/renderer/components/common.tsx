import type { ReactNode } from 'react';
import type { TaskState } from '@quorum/protocol';

const STATE_TONE: Record<TaskState, string> = {
  QUEUED: 'muted',
  AUTHORING: 'info',
  AWAITING_REVIEWER: 'warn',
  IN_REVIEW: 'info',
  MERGE_QUEUED: 'info',
  MERGING: 'info',
  SYNCING: 'info',
  PAUSED: 'warn',
  ESCALATED: 'danger',
  MERGED: 'ok',
  CANCELLED: 'muted',
  FAILED: 'danger',
};

export const STATE_LABEL: Record<TaskState, string> = {
  QUEUED: 'Queued',
  AUTHORING: 'Authoring',
  AWAITING_REVIEWER: 'Waiting for reviewer',
  IN_REVIEW: 'In review',
  MERGE_QUEUED: 'Merge queued',
  MERGING: 'Merging',
  SYNCING: 'Syncing with main',
  PAUSED: 'Paused',
  ESCALATED: 'Needs decision',
  MERGED: 'Merged',
  CANCELLED: 'Cancelled',
  FAILED: 'Failed',
};

export function StateBadge({ state }: { state: TaskState }) {
  return <span className={`badge badge-${STATE_TONE[state]}`}>{STATE_LABEL[state]}</span>;
}

export function Dot({ tone, title }: { tone: 'ok' | 'warn' | 'danger' | 'info' | 'muted'; title?: string }) {
  return <span className={`dot dot-${tone}`} title={title} />;
}

export function Card({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      {(title !== undefined || actions !== undefined) && (
        <header className="card-header">
          <h3>{title}</h3>
          <div className="row">{actions}</div>
        </header>
      )}
      {children}
    </section>
  );
}

export function ErrorNote({ error }: { error: string | null | undefined }) {
  if (error === null || error === undefined) return null;
  return <div className="note note-danger">{error}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Bar({ value, max, tone = 'info' }: { value: number; max: number; tone?: string }) {
  const pct = max <= 0 ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="bar">
      <div className={`bar-fill bar-${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}
