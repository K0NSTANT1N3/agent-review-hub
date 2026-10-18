// Join codes carry everything a teammate's Node needs to connect: Leader URL, agent id, token, repo.
// Format: "quorum1." + base64url(JSON). They contain a secret token: share them privately.
// Produced by the desktop app's Invite and by `quorum-leader invite`; read by the desktop app's Join and by
// `quorum-node join`. Node-only (uses Buffer), so it is a subpath export and not part of the package index.

export interface JoinCode {
  v: 1;
  leaderUrl: string;
  agentId: string;
  ownerName: string;
  token: string;
  repoRemoteUrl: string;
}

const PREFIX = 'quorum1.';

export function encodeJoinCode(code: Omit<JoinCode, 'v'>): string {
  return PREFIX + Buffer.from(JSON.stringify({ v: 1, ...code })).toString('base64url');
}

export function decodeJoinCode(text: string): JoinCode {
  const trimmed = text.trim();
  if (!trimmed.startsWith(PREFIX)) throw new Error('Not a Quorum join code (it should start with "quorum1.")');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(trimmed.slice(PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw new Error('The join code is damaged — ask the host to copy it again');
  }
  const c = parsed as Partial<JoinCode>;
  for (const key of ['leaderUrl', 'agentId', 'ownerName', 'token', 'repoRemoteUrl'] as const) {
    if (typeof c[key] !== 'string' || c[key] === '') throw new Error(`The join code is missing ${key}`);
  }
  if (!/^wss?:\/\//.test(c.leaderUrl!) || !URL.canParse(c.leaderUrl!)) throw new Error('The join code has an invalid Leader URL');
  return c as JoinCode;
}

/** ws(s)://host:port/ws/node → http(s)://host:port */
export function httpBaseFromLeaderUrl(leaderUrl: string): string {
  const u = new URL(leaderUrl);
  u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
  u.pathname = '';
  u.search = '';
  return u.toString().replace(/\/$/, '');
}

/** Agent ids are derived from names: "Ana Smith" → "ana-smith-agent". */
export function agentIdFor(ownerName: string): string {
  const slug = ownerName
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${slug || 'member'}-agent`;
}

/**
 * Leader URL teammates connect to. `publicHost` may be a host name / IP (plain ws on `port`, fine on a LAN or VPN)
 * or a full URL such as a tunnel "https://xyz.trycloudflare.com" (encrypted wss, no port needed).
 */
export function publicLeaderUrl(publicHost: string, port: number): string {
  const value = publicHost.trim();
  if (/^(https?|wss?):\/\//i.test(value)) {
    const u = new URL(value);
    u.protocol = u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss:' : 'ws:';
    u.pathname = '/ws/node';
    u.search = '';
    u.hash = '';
    return u.toString();
  }
  return `ws://${value || '127.0.0.1'}:${port}/ws/node`;
}

/** True when the host's address is a bare host name/IP (IPv6 in brackets) or a full http(s)/ws(s) tunnel URL. */
export function isValidPublicHost(publicHost: string): boolean {
  const value = publicHost.trim();
  if (value === '') return true;
  if (/^(https?|wss?):\/\//i.test(value)) return URL.canParse(value);
  // A bare host must not carry a port, path or spaces: the Leader port is appended separately.
  if (/[/\s]/.test(value) || (value.includes(':') && !/^\[[0-9a-f:.]+\]$/i.test(value))) return false;
  return URL.canParse(`ws://${value}:1/`);
}

export function isEncryptedLeaderUrl(leaderUrl: string): boolean {
  return leaderUrl.startsWith('wss://');
}

/** Private and mesh-VPN names/IPs keep plaintext traffic inside a local network or encrypted VPN. */
export function isPrivateNetworkHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.ts.net')) return true;
  if (host === '::1' || /^(fc|fd)[0-9a-f]{2}:/i.test(host) || /^fe[89ab][0-9a-f]:/i.test(host)) return true;
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || (a === 100 && b! >= 64 && b! <= 127) || a === 127;
}
