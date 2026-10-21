import { homedir } from 'node:os';
import { MAX_TOOL_OUTPUT_BYTES, type AgentToolKindSchema } from '@quorum/protocol';
import type { z } from 'zod';

// Helpers shared by every adapter that emits AgentEvents.

export type AgentToolKind = z.infer<typeof AgentToolKindSchema>;

/** Failure text published on turn.failed is visible to the whole team. */
export const MAX_FAILURE_MESSAGE_CHARS = 2048;

export function redactHomeText(value: string, home: string = homedir()): string {
  if (home.length < 2) return value;
  return value.split(home).join('~');
}

export function sanitizeFailureMessage(value: string, home: string = homedir()): string {
  return redactHomeText(value, home).slice(0, MAX_FAILURE_MESSAGE_CHARS);
}

/** Largest text an AgentEvent `text` or `thinking` event may carry; longer text is split. */
export const MAX_EVENT_TEXT_CHARS = 16384;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Cuts `text` to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function truncateUtf8(text: string, maxBytes: number = MAX_TOOL_OUTPUT_BYTES): string {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  let end = maxBytes;
  // Step back over UTF-8 continuation bytes (10xxxxxx) so the cut lands on a character boundary.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return decoder.decode(bytes.subarray(0, end));
}

/** Splits `text` into chunks of at most `max` characters, never splitting a surrogate pair. */
export function splitText(text: string, max: number = MAX_EVENT_TEXT_CHARS): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + max, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

const TOOL_KINDS: Record<string, AgentToolKind> = {
  read: 'read', view: 'read', cat: 'read', ls: 'read', list: 'read',
  edit: 'edit', multiedit: 'edit', patch: 'edit', apply_patch: 'edit', file_change: 'edit', notebookedit: 'edit',
  write: 'write', create: 'write',
  bash: 'bash', shell: 'bash', exec: 'bash', command_execution: 'bash',
  grep: 'search', glob: 'search', find: 'search', search: 'search', websearch: 'search',
};

/** Maps a native tool name (any adapter, any case) to the normalized tool kind. */
export function toolKindFor(name: string): AgentToolKind {
  return TOOL_KINDS[name.toLowerCase()] ?? 'other';
}
