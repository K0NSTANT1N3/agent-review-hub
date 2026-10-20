import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { ApiTokenScopeSchema, type ApiTokenScope, type ApiTokenView, type TokenScope } from '@quorum/protocol';
import type { AgentRow, ApiTokenRow, LeaderDb } from '../db/repo.js';

// API tokens act as their owner, subject to route scope flags and requester/admin checks.
// They cannot manage tokens; the Node hub only checks agents.token_hash.

export interface Principal {
  agent: AgentRow;
  scope: TokenScope;
  /** Set for API tokens. */
  tokenId?: string;
}

const sha256 = (token: string): Buffer => createHash('sha256').update(token).digest();

function matches(hashHex: string, digest: Buffer): boolean {
  const expected = Buffer.from(hashHex, 'hex');
  return expected.length === digest.length && timingSafeEqual(expected, digest);
}

/** Resolves a bearer token to its agent and scope; null for unknown, revoked or orphaned tokens. */
export function resolvePrincipal(db: LeaderDb, token: string | undefined): Principal | null {
  if (token === undefined || token === '') return null;
  const digest = sha256(token);
  for (const agent of db.agents.all()) {
    if (matches(agent.token_hash, digest)) return agent.revoked === 0 ? { agent, scope: 'full' } : null;
  }
  for (const row of db.apiTokens.all()) {
    if (!matches(row.token_hash, digest)) continue;
    const agent = db.agents.get(row.agent_id);
    if (row.revoked_at !== null || agent === undefined || agent.revoked !== 0) return null;
    const scope = ApiTokenScopeSchema.safeParse(row.scope);
    return scope.success ? { agent, scope: scope.data, tokenId: row.id } : null;
  }
  return null;
}

/** Creates an API token for `agentId`. The plaintext is returned once and only its hash is stored. */
export function mintApiToken(db: LeaderDb, agentId: string, label: string, now: number, scope: ApiTokenScope = 'requester'): { row: ApiTokenRow; token: string } {
  ApiTokenScopeSchema.parse(scope);
  const token = `qrq_${randomBytes(32).toString('base64url')}`;
  const row = db.apiTokens.insert({
    id: randomUUID(),
    agent_id: agentId,
    token_hash: sha256(token).toString('hex'),
    scope,
    label,
    created_at: now,
  });
  return { row, token };
}

/** Revokes every live API token of an agent (used when the agent's own token is rotated or revoked). */
export function revokeAgentApiTokens(db: LeaderDb, agentId: string, now: number): void {
  for (const row of db.apiTokens.find({ agent_id: agentId, revoked_at: null })) db.apiTokens.update(row.id, { revoked_at: now });
}

export function apiTokenView(row: ApiTokenRow): ApiTokenView {
  return {
    id: row.id,
    agentId: row.agent_id,
    scope: ApiTokenScopeSchema.parse(row.scope),
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}
