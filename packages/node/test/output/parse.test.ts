import {
  AuthorReviseOutputSchema,
  AuthorStartOutputSchema,
  ReviewOutputSchema,
} from '@quorum/protocol/agent-output';
import { describe, expect, it } from 'vitest';
import { parseOutput } from '../../src/output/parse.js';

function block(json: string): string {
  return `text before\n\`\`\`quorum-json\n${json}\n\`\`\``;
}

describe('parseOutput', () => {
  it('parses a valid output block', () => {
    const result = parseOutput(
      block('{"status":"done","summary":"Implemented the widget."}'),
      AuthorStartOutputSchema,
    );
    expect(result).toEqual({
      ok: true,
      value: { status: 'done', summary: 'Implemented the widget.' },
    });
  });

  it('reports a missing output block with the retry prompt from the spec', () => {
    const result = parseOutput('No structured response.', AuthorStartOutputSchema);
    expect(result).toEqual({
      ok: false,
      error: 'No `quorum-json` block found.',
      retryPrompt: 'Your previous reply did not end with a valid quorum-json block. Validation error: No `quorum-json` block found. Reply with only the corrected block.',
    });
  });

  it('uses the last output block', () => {
    const result = parseOutput(
      `${block('{"status":"done","summary":"First."}')}\n${block('{"status":"blocked","summary":"Second.","blockedReason":"Need a decision."}')}`,
      AuthorStartOutputSchema,
    );
    expect(result).toEqual({
      ok: true,
      value: { status: 'blocked', summary: 'Second.', blockedReason: 'Need a decision.' },
    });
  });

  it('rejects malformed JSON', () => {
    const result = parseOutput(block('{"status":'), AuthorStartOutputSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryPrompt).toContain('Validation error:');
  });

  it('rejects a last block without its closing fence instead of using an earlier block', () => {
    const result = parseOutput(
      `${block('{"status":"done","summary":"First."}')}\n\`\`\`quorum-json\n{"status":"done"}`,
      AuthorStartOutputSchema,
    );
    expect(result).toMatchObject({
      ok: false,
      error: 'The last `quorum-json` block has no closing fence.',
    });
  });

  it('rejects schema-invalid output', () => {
    const result = parseOutput(block('{"summary":"No status."}'), AuthorStartOutputSchema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryPrompt).toContain('Validation error:');
  });

  it('requires responses to cover exactly the supplied blocking issue codes', () => {
    const valid = parseOutput(
      block('{"status":"done","summary":"Fixed it.","responses":[{"issue":"I1","action":"fixed","note":"Guard added."}]}'),
      AuthorReviseOutputSchema,
      { blockingIssueCodes: ['I1'] },
    );
    expect(valid.ok).toBe(true);

    const missing = parseOutput(
      block('{"status":"done","summary":"Fixed it.","responses":[]}'),
      AuthorReviseOutputSchema,
      { blockingIssueCodes: ['I1'] },
    );
    expect(missing).toMatchObject({ ok: false, error: 'responses must cover exactly the supplied issue codes (missing: I1).' });

    const extra = parseOutput(
      block('{"status":"done","summary":"Fixed it.","responses":[{"issue":"I1","action":"fixed"},{"issue":"I2","action":"disputed"}]}'),
      AuthorReviseOutputSchema,
      { blockingIssueCodes: ['I1'] },
    );
    expect(extra).toMatchObject({ ok: false, error: 'responses must cover exactly the supplied issue codes (unexpected: I2).' });

    const duplicate = parseOutput(
      block('{"status":"done","summary":"Fixed it.","responses":[{"issue":"I1","action":"fixed"},{"issue":"I1","action":"disputed"}]}'),
      AuthorReviseOutputSchema,
      { blockingIssueCodes: ['I1'] },
    );
    expect(duplicate).toMatchObject({ ok: false, error: 'responses must cover exactly the supplied issue codes (duplicated: I1).' });
  });

  it('requires previousIssues to cover exactly the supplied prior codes', () => {
    const result = parseOutput(
      block('{"verdict":"approve","summary":"Looks good.","previousIssues":[{"issue":"I1","status":"resolved"}]}'),
      ReviewOutputSchema,
      { priorIssueCodes: ['I1', 'I2'] },
    );
    expect(result).toMatchObject({ ok: false, error: 'previousIssues must cover exactly the supplied issue codes (missing: I2).' });
  });
});
