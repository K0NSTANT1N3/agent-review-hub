import { describe, expect, it } from 'vitest';
import { CLI_ADAPTER_TRUST_NOTE, CLI_ADAPTER_TYPES, isCliAdapter, settingsAdapter, WELCOME_REQUIREMENTS } from '../src/shared/adapter-choice.js';

describe('desktop adapter choice', () => {
  it('adds codex, pi, omp and kilo with the same optional fields and a one-line trust note', () => {
    expect(CLI_ADAPTER_TYPES).toEqual(['codex', 'pi', 'omp', 'kilo']);
    expect(CLI_ADAPTER_TRUST_NOTE.codex).toBe('Sandboxed by Codex; writes limited to the worktree.');
    expect(CLI_ADAPTER_TRUST_NOTE.pi).toBe('Low trust: Quorum cannot enforce tool limits.');
    expect(CLI_ADAPTER_TRUST_NOTE.omp).toBe('Low trust: Quorum cannot enforce tool limits.');
    expect(CLI_ADAPTER_TRUST_NOTE.kilo).toContain('Low trust');
    expect(() => settingsAdapter('custom')).toThrow(/profile commands/);
    for (const type of CLI_ADAPTER_TYPES) {
      expect(settingsAdapter(type)).toEqual({ type, contextWindow: 200000 });
      expect(isCliAdapter(settingsAdapter(type))).toBe(true);
    }
    expect(settingsAdapter('claude-code')).toEqual({ type: 'claude-code', contextWindow: 200000 });
    expect(settingsAdapter('opencode')).toMatchObject({ type: 'opencode', baseUrl: 'http://localhost:4096' });
    expect(settingsAdapter('mock')).toEqual({ type: 'mock', scriptPath: '', contextWindow: 200000 });
    expect(isCliAdapter(settingsAdapter('claude-code'))).toBe(false);
  });

  it('welcome screen asks for Git access and one supported agent, not Claude Code only', () => {
    expect(WELCOME_REQUIREMENTS).toContain('Git access to the team repository');
    expect(WELCOME_REQUIREMENTS).toContain('one supported coding agent installed and logged in');
    for (const agent of ['Claude Code', 'Codex', 'pi', 'omp', 'Kilo Code']) expect(WELCOME_REQUIREMENTS).toContain(agent);
    expect(WELCOME_REQUIREMENTS).not.toMatch(/run claude once|a logged-in Claude Code/);
  });
});
