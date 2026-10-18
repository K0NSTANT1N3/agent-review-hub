import type { LeaderConfig } from '@quorum/protocol';
import { agentIdFor, encodeJoinCode, isValidPublicHost, publicLeaderUrl } from '@quorum/protocol/join-code';
import { addAgent, listAgents } from './index.js';

export interface InviteArgs {
  name: string;
  /** Agent id; derived from the name when omitted ("Ana Smith" -> "ana-smith-agent"). */
  id?: string;
  /** Host name / IP teammates reach, or a full https:// tunnel URL. */
  publicHost?: string;
  /** Port teammates reach for a bare host; defaults to the Leader's listen port. */
  port?: number;
  /** Issue a new token for an agent that already exists (its old token stops working). */
  rotate?: boolean;
}

export interface Invite {
  joinCode: string;
  agentId: string;
  leaderUrl: string;
  warnings: string[];
}

/**
 * The Leader URL a teammate's Node dials. Same rules as the desktop app, plus: a Leader with its own
 * TLS certificate serves wss:// on its port, so a bare host gets wss:// too.
 */
export function inviteLeaderUrl(config: LeaderConfig, publicHost: string, port: number): string {
  const value = publicHost.trim();
  if (!isValidPublicHost(value) || value === '') {
    throw new Error('--public-host must be a host name or IP without a port (IPv6 in [ ]), or a full https:// tunnel URL');
  }
  const bare = !/^(https?|wss?):\/\//i.test(value);
  if (bare && config.tls.certFile !== null) return publicLeaderUrl(`https://${value}:${port}`, port);
  return publicLeaderUrl(value, port);
}

export async function createInvite(config: LeaderConfig, args: InviteArgs): Promise<Invite> {
  const name = args.name.trim();
  if (name === '') throw new Error('--name is required');
  const port = args.port ?? config.listen.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be 1-65535');
  const warnings: string[] = [];
  let publicHost = args.publicHost?.trim() ?? '';
  if (publicHost === '') {
    const listenHost = config.listen.host;
    publicHost = listenHost === '0.0.0.0' || listenHost === '::' ? '127.0.0.1' : listenHost;
    warnings.push(`No --public-host given; the join code points at ${publicHost}, which only this machine can reach. Pass the address teammates use.`);
  }
  const leaderUrl = inviteLeaderUrl(config, publicHost, port);
  const agentId = args.id?.trim() || agentIdFor(name);
  const existing = (await listAgents(config.dbPath)).find((agent) => agent.id === agentId);
  if (existing !== undefined && !existing.revoked && args.rotate !== true) {
    throw new Error(`Agent ${agentId} already exists. Pass --rotate to issue a new token (its current token and CLI tokens stop working), or pick another --id.`);
  }
  if (leaderUrl.startsWith('ws://') && !/^ws:\/\/(127\.|localhost|\[::1\])/.test(leaderUrl)) {
    warnings.push('The join code uses unencrypted ws://. Use it only on a LAN or VPN; on the internet configure tls.certFile/keyFile or pass an https:// tunnel URL.');
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(config.repo.remoteUrl) && !/^[^/\s]+@[^/\s]+:/.test(config.repo.remoteUrl)) {
    warnings.push(`repo.remoteUrl (${config.repo.remoteUrl}) looks like a local path; teammates on other machines cannot clone it.`);
  }
  const { token } = await addAgent(config.dbPath, { id: agentId, owner: name });
  return {
    joinCode: encodeJoinCode({ leaderUrl, agentId, ownerName: name, token, repoRemoteUrl: config.repo.remoteUrl }),
    agentId,
    leaderUrl,
    warnings,
  };
}
