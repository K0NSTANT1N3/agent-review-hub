import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TokenScopeChoice } from '../../src/renderer/components/TokenScopeChoice';
import { API_TOKEN_PATTERN, createTokenRequest, DEFAULT_TOKEN_SCOPE, ownerTokenWarning, tokenCommand, tokenScopeLabel } from '../../src/shared/cli-tokens';

const render = (value: 'requester' | 'owner', isAdmin = false) => renderToStaticMarkup(<TokenScopeChoice value={value} isAdmin={isAdmin} onChange={() => {}} />);
const checked = (html: string) => [...html.matchAll(/<input[^>]*value="(\w+)"[^>]*>/g)].filter((m) => m[0].includes('checked')).map((m) => m[1]);

describe('token scope choice', () => {
  it('defaults to a requester CLI token and offers the owner terminal UI token', () => {
    expect(DEFAULT_TOKEN_SCOPE).toBe('requester');
    const html = render(DEFAULT_TOKEN_SCOPE);
    expect(html).toContain('CLI (requester)');
    expect(html).toContain('Terminal UI (owner)');
    expect(checked(html)).toEqual(['requester']);
    expect(html).not.toContain('Store it like a password');
  });

  it('warns before an owner token, naming every task for an admin', () => {
    const html = render('owner');
    expect(checked(html)).toEqual(['owner']);
    expect(html).toContain('approve and merge-approve, send back, pause and cancel your tasks. Store it like a password.');
    expect(render('owner', true)).toContain('every task in the team');
    expect(ownerTokenWarning(true)).not.toContain('your tasks');
  });

  it('sends the chosen scope with a default label and labels listed tokens by scope', () => {
    expect(createTokenRequest('  ', 'requester')).toEqual({ label: 'quorum CLI', scope: 'requester' });
    expect(createTokenRequest(' laptop ', 'owner')).toEqual({ label: 'laptop', scope: 'owner' });
    expect(tokenScopeLabel('owner')).toBe('Terminal UI (owner)');
    expect(tokenScopeLabel('requester')).toBe('CLI (requester)');
    expect(tokenCommand('requester', 'http://h:7420', 'qrq_t')).toBe('quorum login --url http://h:7420 --token qrq_t');
    expect(tokenCommand('owner', null, 'qrq_t')).toBe('quorum tui --url <leader url> --token qrq_t');
  });

  it('recognizes only Leader-minted API tokens', () => {
    expect(API_TOKEN_PATTERN.test(`qrq_${'A'.repeat(43)}`)).toBe(true);
    for (const bad of ['qrq_short', `qrm_${'A'.repeat(43)}`, `qrq_${'A'.repeat(43)}\n`, `qrq_${'+'.repeat(43)}`]) expect(API_TOKEN_PATTERN.test(bad)).toBe(false);
  });
});
