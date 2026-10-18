import { describe, expect, it } from 'vitest';
import { addressOptionsFrom, classifyAddress, leaderNetworkKind } from '../src/main/network.js';

describe('classifyAddress', () => {
  it.each([
    ['tailscale0', '100.101.102.103', 'tailscale'],
    ['Tailscale', '100.70.1.2', 'tailscale'],
    ['utun4', '100.88.1.2', 'tailscale'],
    ['ztabcdef12', '10.147.17.5', 'zerotier'],
    ['ZeroTier One [abc]', '10.147.17.5', 'zerotier'],
    ['wg0', '10.8.0.2', 'wireguard'],
    ['tun0', '10.9.0.2', 'vpn'],
    ['wlp0s20f3', '192.168.72.122', 'local'],
    ['Wi-Fi', '10.0.0.12', 'local'],
    ['eth0', '203.0.113.7', 'public'],
    ['eth0', '100.64.1.1', 'public'],
  ])('%s %s → %s', (iface, ip, kind) => {
    expect(classifyAddress(iface, ip, false)).toBe(kind);
  });

  it('hides loopback, link-local and container bridges', () => {
    expect(classifyAddress('lo', '127.0.0.1', true)).toBeNull();
    expect(classifyAddress('eth0', '169.254.3.4', false)).toBeNull();
    expect(classifyAddress('docker0', '172.17.0.1', false)).toBeNull();
    expect(classifyAddress('br-22f03920d83d', '172.19.0.1', false)).toBeNull();
  });
});

describe('addressOptionsFrom', () => {
  it('orders VPNs first, prefers the stable Tailscale name, and recommends one', () => {
    const opts = addressOptionsFrom(
      {
        lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
        wlp0s20f3: [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
        tailscale0: [
          { address: '100.101.102.103', family: 'IPv4', internal: false },
          { address: 'fd7a::1', family: 'IPv6', internal: false },
        ],
        docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }],
      },
      { dnsName: 'ana.tail1234.ts.net', ip: '100.101.102.103' },
    );
    expect(opts.map((o) => [o.address, o.kind])).toEqual([
      ['ana.tail1234.ts.net', 'tailscale'],
      ['100.101.102.103', 'tailscale'],
      ['192.168.1.20', 'local'],
    ]);
    expect(opts[0]).toMatchObject({ recommended: true, bindIp: '100.101.102.103' });
    expect(opts.filter((o) => o.recommended)).toHaveLength(1);
  });

  it('recommends the LAN address when no VPN exists', () => {
    const opts = addressOptionsFrom({ en0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }] });
    expect(opts).toEqual([expect.objectContaining({ address: '192.168.1.20', kind: 'local', recommended: true })]);
  });
});

describe('leaderNetworkKind', () => {
  it.each([
    ['ws://ana.tail1234.ts.net:7420/ws/node', 'tailscale'],
    ['ws://100.101.102.103:7420/ws/node', 'tailscale'],
    ['ws://192.168.1.20:7420/ws/node', 'local'],
    ['wss://abc.trycloudflare.com/ws/node', 'tunnel'],
    ['ws://203.0.113.7:7420/ws/node', 'public'],
    ['ws://127.0.0.1:7420/ws/node', 'loopback'],
  ])('%s → %s', (url, kind) => {
    expect(leaderNetworkKind(url)).toBe(kind);
  });
});
