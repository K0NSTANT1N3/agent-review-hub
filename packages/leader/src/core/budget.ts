import type { LeaderConfig } from '@quorum/protocol';
import type { AgentRow, LeaderDb, TaskRow } from '../db/repo.js';

// Spec §7 (token accounting) and §9.1 (estimates, overlap).

/** Most recent local midnight in `tz` at or before `now` (ms). */
export function dayStart(now: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(now));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  // Some runtimes render midnight as hour "24".
  const elapsed = (((get('hour') % 24) * 60 + get('minute')) * 60 + get('second')) * 1000 + (now % 1000);
  return now - elapsed;
}

export function lentToday(db: LeaderDb, agentId: string, now: number, tz: string): number {
  return db.usageTokensSince(agentId, 'lent', dayStart(now, tz));
}

export function budgetRemaining(db: LeaderDb, agent: AgentRow, now: number, tz: string): number {
  return agent.lend_tokens_per_day - lentToday(db, agent.id, now, tz);
}

export function taskFiles(task: TaskRow): string[] {
  return JSON.parse(task.files) as string[];
}

export function estimateReview(agent: AgentRow, task: TaskRow, cfg: LeaderConfig['costEstimate']): number {
  return Math.round(agent.cost_ratio_ema * (cfg.baseTokens + cfg.perDiffLine * task.diff_lines + cfg.perChangedFile * taskFiles(task).length));
}

export function estimateAuthor(agent: AgentRow, cfg: LeaderConfig['costEstimate']): number {
  return Math.round(agent.cost_ratio_ema * cfg.authorTaskTokens);
}

/** Every parent directory prefix of each path, e.g. 'src/', 'src/auth/'. */
export function dirsOf(paths: Iterable<string>): Set<string> {
  const dirs = new Set<string>();
  for (const p of paths) {
    const segments = p.split('/');
    for (let i = 1; i < segments.length; i += 1) dirs.add(`${segments.slice(0, i).join('/')}/`);
  }
  return dirs;
}

/** overlap(X, Y) ∈ [0,1] — spec §9.1. */
export function overlap(taskPaths: readonly string[], sessionPaths: readonly string[]): number {
  if (taskPaths.length === 0) return 0;
  const y = new Set(sessionPaths);
  const fileOverlap = taskPaths.filter((p) => y.has(p)).length / Math.max(1, taskPaths.length);
  const dx = dirsOf(taskPaths);
  const dy = dirsOf(sessionPaths);
  const dirOverlap = [...dx].filter((d) => dy.has(d)).length / Math.max(1, dx.size);
  return 0.7 * fileOverlap + 0.3 * dirOverlap;
}
