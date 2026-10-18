import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import type { AddressKind, AddressOption } from '../shared/ipc.js';

// Which addresses can teammates use to reach this computer? Quorum works with any VPN; it only labels the
// addresses the computer already has. Nothing here installs or controls a VPN.

const DOCKER_LIKE = /^(docker|br-|veth|virbr|vmnet|vboxnet|cni|flannel|kube|lxc|lxd)/i;

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

function inRange(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

export function isPrivateLan(ip: string): boolean {
  return inRange(ip, '10.0.0.0', 8) || inRange(ip, '172.16.0.0', 12) || inRange(ip, '192.168.0.0', 16);
}

/** Tailscale (and some other mesh VPNs) use the 100.64.0.0/10 shared address space. */
export function isTailscaleRange(ip: string): boolean {
  return inRange(ip, '100.64.0.0', 10);
}

/** Classifies one interface address. Returns null for addresses teammates can never use. */
export function classifyAddress(iface: string, ip: string, internal: boolean): AddressKind | null {
  if (internal || ip.startsWith('127.') || ip.startsWith('169.254.')) return null;
  if (DOCKER_LIKE.test(iface)) return null;
  const name = iface.toLowerCase();
  if (name.includes('tailscale') || (isTailscaleRange(ip) && !/^(eth|en|wl|wi-?fi|ethernet)/.test(name))) return 'tailscale';
  if (name.startsWith('zt') || name.includes('zerotier')) return 'zerotier';
  if (name.startsWith('wg') || name.includes('wireguard')) return 'wireguard';
  if (/^(tun|tap|utun|ppp|ipsec|nordlynx|proton)/.test(name) || name.includes('vpn')) return 'vpn';
  if (isPrivateLan(ip)) return 'local';
  return 'public';
}

const LABEL: Record<AddressKind, string> = {
  tailscale: 'Tailscale: reachable from anywhere on your tailnet',
  zerotier: 'ZeroTier network',
  wireguard: 'WireGuard VPN',
  vpn: 'VPN',
  local: 'Local network: same Wi-Fi / office only',
  public: 'Public internet address (needs port forwarding)',
};

const ORDER: AddressKind[] = ['tailscale', 'zerotier', 'wireguard', 'vpn', 'local', 'public'];

export function addressOptionsFrom(
  interfaces: Record<string, { address: string; family: string | number; internal: boolean }[] | undefined>,
  tailscaleName?: { dnsName: string; ip: string },
): AddressOption[] {
  const options: AddressOption[] = [];
  for (const [iface, list] of Object.entries(interfaces)) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      const kind = classifyAddress(iface, a.address, a.internal);
      if (kind === null) continue;
      options.push({ address: a.address, bindIp: a.address, kind, label: LABEL[kind], interfaceName: iface, recommended: false });
    }
  }
  if (tailscaleName !== undefined) {
    // The MagicDNS name survives IP changes, so it goes first; it binds to the Tailscale IP.
    options.push({ address: tailscaleName.dnsName, bindIp: tailscaleName.ip, kind: 'tailscale', label: `${LABEL.tailscale} (stable name)`, interfaceName: 'tailscale', recommended: false });
  }
  options.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || Number(b.address.includes('.ts.net')) - Number(a.address.includes('.ts.net')));
  const best = options.find((o) => o.kind !== 'public');
  if (best !== undefined) best.recommended = true;
  return options;
}

/** Asks a locally installed Tailscale for this machine's stable MagicDNS name (no network calls). */
export function tailscaleSelf(): Promise<{ dnsName: string; ip: string } | undefined> {
  const candidates = [
    'tailscale',
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    'C:\\Program Files\\Tailscale\\tailscale.exe',
  ].filter((c) => c === 'tailscale' || existsSync(c));
  const attempt = (i: number): Promise<{ dnsName: string; ip: string } | undefined> =>
    i >= candidates.length
      ? Promise.resolve(undefined)
      : new Promise((resolve) => {
          execFile(candidates[i]!, ['status', '--json'], { timeout: 3000 }, (error, stdout) => {
            if (error !== null) return resolve(attempt(i + 1));
            try {
              const self = (JSON.parse(stdout) as { Self?: { DNSName?: string; TailscaleIPs?: string[] } }).Self;
              const dnsName = self?.DNSName?.replace(/\.$/, '');
              const ip = self?.TailscaleIPs?.find((x) => x.includes('.'));
              resolve(dnsName && ip ? { dnsName, ip } : undefined);
            } catch {
              resolve(undefined);
            }
          });
        });
  return attempt(0);
}

export async function addressOptions(): Promise<AddressOption[]> {
  return addressOptionsFrom(networkInterfaces(), await tailscaleSelf());
}

/** What kind of network a Leader URL points at — used to explain connection problems to teammates. */
export function leaderNetworkKind(leaderUrl: string): AddressKind | 'tunnel' | 'loopback' {
  const host = new URL(leaderUrl).hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.startsWith('127.')) return 'loopback';
  if (host.endsWith('.ts.net')) return 'tailscale';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (isTailscaleRange(host)) return 'tailscale';
    if (isPrivateLan(host)) return 'local';
    return 'public';
  }
  return leaderUrl.startsWith('wss://') ? 'tunnel' : 'public';
}
