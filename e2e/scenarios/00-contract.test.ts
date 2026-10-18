import { describe, expect, it } from 'vitest';
import * as leader from '@quorum/leader';
import * as node from '@quorum/node';
import { parseLeaderConfig, parseNodeConfig } from '@quorum/protocol';

describe('cross-package contract (tasks/*.md §3)', () => {
  it('exports the agreed entry points', () => {
    expect(typeof leader.startLeader).toBe('function');
    expect(typeof leader.addAgent).toBe('function');
    expect(typeof node.startDaemon).toBe('function');
    expect(typeof node.AdapterError).toBe('function');
  });

  it('config schemas apply defaults', () => {
    const lc = parseLeaderConfig({ repo: { remoteUrl: '/tmp/x.git' } });
    expect(lc.listen.port).toBe(7420);
    expect(lc.scheduler.weights.affinity).toBe(3);
    const nc = parseNodeConfig({
      leaderUrl: 'ws://127.0.0.1:1/ws/node',
      agentId: 'a',
      token: 't',
      ownerName: 'o',
      repoRemoteUrl: '/tmp/x.git',
      gitIdentity: { name: 'n', email: 'e@x' },
      adapter: { type: 'mock', scriptPath: './s.json' },
    });
    expect(nc.adapter.contextWindow).toBe(200000);
    expect(nc.lendMode).toBe('when_idle');
  });
});
