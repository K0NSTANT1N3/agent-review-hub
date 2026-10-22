import type { ApiTokenScope } from '@quorum/protocol';
import { ownerTokenWarning, TOKEN_SCOPES } from '../../shared/cli-tokens';

export function TokenScopeChoice({ value, isAdmin, onChange }: { value: ApiTokenScope; isAdmin: boolean; onChange: (scope: ApiTokenScope) => void }) {
  return (
    <div className="stack-sm" role="radiogroup" aria-label="Token type">
      {TOKEN_SCOPES.map((o) => (
        <label key={o.scope} className="radio">
          <input type="radio" name="token-scope" value={o.scope} checked={value === o.scope} onChange={() => onChange(o.scope)} />
          {o.label}
        </label>
      ))}
      {value === 'owner' && <div className="note note-warn">{ownerTokenWarning(isAdmin)}</div>}
    </div>
  );
}
