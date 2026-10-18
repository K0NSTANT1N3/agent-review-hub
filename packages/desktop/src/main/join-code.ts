// Join codes carry everything a teammate's app needs to connect: Leader URL, agent id, token, repo.
// Format: "quorum1." + base64url(JSON). They contain a secret token — share them privately.

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

export function isEncryptedLeaderUrl(leaderUrl: string): boolean {
  return leaderUrl.startsWith('wss://');
}
