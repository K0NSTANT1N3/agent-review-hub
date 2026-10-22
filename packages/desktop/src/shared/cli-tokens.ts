import type { ApiTokenScope, CreateApiTokenRequest } from '@quorum/protocol';

// Scope choice for Settings → Agent CLI access. The Leader mints both scopes for the app's full agent credential.

export const DEFAULT_TOKEN_SCOPE: ApiTokenScope = 'requester';

export const TOKEN_SCOPES: readonly { scope: ApiTokenScope; label: string }[] = [
  { scope: 'requester', label: 'CLI (requester)' },
  { scope: 'owner', label: 'Terminal UI (owner)' },
];

export function tokenScopeLabel(scope: ApiTokenScope): string {
  return TOKEN_SCOPES.find((o) => o.scope === scope)?.label ?? scope;
}

export function createTokenRequest(label: string, scope: ApiTokenScope): CreateApiTokenRequest {
  return { label: label.trim() || (scope === 'owner' ? 'quorum tui' : 'quorum CLI'), scope };
}

/** Requester tokens only. Owner tokens are never shown in a command line, which would put them in shell history. */
export function loginCommand(url: string | null, token: string): string {
  return `quorum login --url ${url ?? '<leader url>'} --token ${token}`;
}

/** Shown before an owner token is created. Admin owner tokens act on every task (see the Leader's requesterOrAdmin check). */
export function ownerTokenWarning(isAdmin: boolean): string {
  const whose = isAdmin ? 'every task in the team (you are an admin)' : 'your tasks';
  return `An owner token can approve and merge-approve, send back, pause and cancel ${whose}. Store it like a password.`;
}

/** A token minted by the Leader: `qrq_` and 32 random bytes in base64url. */
export const API_TOKEN_PATTERN = /^qrq_[A-Za-z0-9_-]{43}$/;
