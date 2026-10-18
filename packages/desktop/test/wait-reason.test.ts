import { describe, expect, it } from 'vitest';
import { TaskWaitCodeSchema, type TaskWaitReason } from '@quorum/protocol';
import { blockerLabel, waitText } from '../src/renderer/wait-reason.js';

const reason = (patch: Partial<TaskWaitReason> = {}): TaskWaitReason => ({
  role: 'author', code: 'assigning', nextStep: 'wait', agentId: null, ownerName: null, until: null, blockers: [], ...patch,
});

describe('waitText', () => {
  it('describes every wait code with a short line and a detail', () => {
    for (const code of TaskWaitCodeSchema.options) {
      for (const role of ['author', 'reviewer'] as const) {
        const text = waitText({ state: role === 'author' ? 'QUEUED' : 'AWAITING_REVIEWER', waitReason: reason({ code, role }) });
        expect(text?.short, code).toMatch(/\S/);
        expect(text?.detail, code).toMatch(/\S/);
      }
    }
  });

  it('explains reserved review capacity as a wait without suggesting settings changes', () => {
    expect(waitText({ state: 'QUEUED', waitReason: reason({ code: 'review_capacity' }) })).toMatchObject({
      short: 'Waiting for review capacity', action: null, tone: 'muted',
    });
    expect(blockerLabel({ agentId: 'a', ownerName: 'a', blocker: 'review_capacity', until: null })).toBe('reserving capacity for reviews');
  });

  it('names the agent and the next step for the viewer', () => {
    const offline = reason({ code: 'no_agent_online', nextStep: 'connect_agent', agentId: 'alice-claude', ownerName: 'alice' });
    expect(waitText({ state: 'QUEUED', waitReason: offline }, 'alice')).toMatchObject({ short: 'alice-claude is offline', action: 'Start your agent from the Dashboard.', tone: 'warn' });
    expect(waitText({ state: 'QUEUED', waitReason: offline }, 'bob')?.action).toBe('Ask alice to connect alice-claude.');
    const paused = reason({ code: 'agent_paused', nextStep: 'resume_agent', agentId: 'bob-claude', ownerName: 'bob', role: 'reviewer' });
    expect(waitText({ state: 'AWAITING_REVIEWER', waitReason: paused }, 'alice')?.action).toBe('Ask bob to resume bob-claude. You can also approve and merge without a review.');
  });

  it('hides reasons outside waiting states and falls back for missing or unknown reasons', () => {
    expect(waitText({ state: 'AUTHORING', waitReason: reason() })).toBeNull();
    expect(waitText({ state: 'PAUSED', waitReason: null })).toBeNull();
    expect(waitText({ state: 'QUEUED', waitReason: null })).toMatchObject({ short: 'Waiting for an agent' });
    expect(waitText({ state: 'QUEUED', waitReason: reason({ code: 'something_new' as TaskWaitReason['code'] }) })).toMatchObject({ short: 'Waiting for an agent' });
  });

  it('labels per-agent blockers, with the time they clear when known', () => {
    expect(blockerLabel({ agentId: 'a', ownerName: 'a', blocker: 'busy', until: null })).toBe('all sessions busy');
    expect(blockerLabel({ agentId: 'a', ownerName: 'a', blocker: 'rate_limited', until: Date.UTC(2026, 0, 1) })).toMatch(/^rate-limited until /);
  });
});
