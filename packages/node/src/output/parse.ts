import {
  checkCoverage,
  QUORUM_JSON_FENCE,
} from '@quorum/protocol/agent-output';
import type { ZodType } from 'zod';

export interface ParseOutputOptions {
  /** Blocking issue codes an author.revise response must cover exactly once. */
  blockingIssueCodes?: readonly string[];
  /** Prior issue codes a review.rereview response must cover exactly once. */
  priorIssueCodes?: readonly string[];
}

export type ParseOutputResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; retryPrompt: string };

export function parseOutput<T>(
  text: string,
  schema: ZodType<T>,
  options: ParseOutputOptions = {},
): ParseOutputResult<T> {
  const block = lastQuorumJsonBlock(text);
  if (!block.ok) return failure(block.error);

  let parsed: unknown;
  try {
    parsed = JSON.parse(block.value) as unknown;
  } catch (error) {
    return failure(error instanceof Error ? error.message : 'Invalid JSON.');
  }

  const result = schema.safeParse(parsed);
  if (!result.success) return failure(result.error.message);

  const coverageError = validateCoverage(result.data, options);
  if (coverageError !== null) return failure(coverageError);
  return { ok: true, value: result.data };
}

function lastQuorumJsonBlock(text: string):
  | { ok: true; value: string }
  | { ok: false; error: string } {
  const opening = new RegExp(`^ {0,3}\`\`\`${QUORUM_JSON_FENCE}[ \\t]*\\r?$`, 'gm');
  let lastOpening: RegExpExecArray | null = null;
  for (let match = opening.exec(text); match !== null; match = opening.exec(text)) {
    lastOpening = match;
  }
  if (lastOpening === null || lastOpening.index === undefined) {
    return { ok: false, error: `No \`${QUORUM_JSON_FENCE}\` block found.` };
  }

  const afterOpening = lastOpening.index + lastOpening[0].length;
  const lineBreak = /^\r?\n/.exec(text.slice(afterOpening));
  if (lineBreak === null) {
    return { ok: false, error: `The last \`${QUORUM_JSON_FENCE}\` block has no opening line break.` };
  }

  const bodyStart = afterOpening + lineBreak[0].length;
  const closing = /^ {0,3}```[ \t]*\r?$/gm;
  closing.lastIndex = bodyStart;
  const closeMatch = closing.exec(text);
  if (closeMatch === null || closeMatch.index === undefined) {
    return { ok: false, error: `The last \`${QUORUM_JSON_FENCE}\` block has no closing fence.` };
  }

  return { ok: true, value: text.slice(bodyStart, closeMatch.index).trim() };
}

function validateCoverage(value: unknown, options: ParseOutputOptions): string | null {
  const record = asRecord(value);
  if (record === null) return null;

  if (options.blockingIssueCodes !== undefined) {
    const error = coverageError(
      'responses',
      getCodes(record.responses, 'issue'),
      options.blockingIssueCodes,
    );
    if (error !== null) return error;
  }

  if (options.priorIssueCodes !== undefined) {
    const error = coverageError(
      'previousIssues',
      getCodes(record.previousIssues, 'issue'),
      options.priorIssueCodes,
    );
    if (error !== null) return error;
  }

  return null;
}

function coverageError(
  field: string,
  actual: readonly string[],
  expected: readonly string[],
): string | null {
  const result = checkCoverage(actual, expected);
  if (result.ok) return null;

  const details: string[] = [];
  if (result.missing.length > 0) details.push(`missing: ${result.missing.join(', ')}`);
  if (result.unexpected.length > 0) details.push(`unexpected: ${result.unexpected.join(', ')}`);
  if (result.duplicated.length > 0) details.push(`duplicated: ${result.duplicated.join(', ')}`);
  return `${field} must cover exactly the supplied issue codes (${details.join('; ')}).`;
}

function getCodes(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) return [];
  const codes: string[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const code = record?.[key];
    if (typeof code === 'string') codes.push(code);
  }
  return codes;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function failure(error: string): ParseOutputResult<never> {
  const retryError = error.replace(/[.!?]+$/, '');
  return {
    ok: false,
    error,
    retryPrompt: `Your previous reply did not end with a valid quorum-json block. Validation error: ${retryError}. Reply with only the corrected block.`,
  };
}
