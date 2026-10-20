import type { ChatEntry } from '../chat-model.js';
import { cleanText, fit, widthOf, wrap } from '../text.js';
import type { DisplayLine } from './panel.js';

export function chatLines(entries: ChatEntry[], width: number, tick = 0): DisplayLine[] {
  const lines: DisplayLine[] = [];
  let speaker = '';
  for (const entry of entries) {
    if (entry.speaker !== speaker) {
      lines.push({ text: `${new Date(entry.at).toISOString().slice(11, 19)} ${entry.speaker}`, bold: true });
      speaker = entry.speaker;
    }
    let text = entry.kind === 'thinking' ? `thinking · ${cleanText(entry.text).replace(/\s+/g, ' ')}`
      : entry.kind === 'status' ? `${['⠋', '⠙', '⠹', '⠸'][tick % 4]} ${entry.text}` : entry.text;
    if (entry.kind === 'tool') {
      const outcome = / · (running|ok|failed)( · exit -?\d+)?$/.exec(text);
      if (outcome && widthOf(text) > width - 2) text = `${fit(text.slice(0, outcome.index), Math.max(0, width - 2 - widthOf(outcome[0])))}${outcome[0]}`;
    }
    const content = entry.kind === 'thinking' || entry.kind === 'tool' || entry.kind === 'status' ? [text.replace(/\s+/g, ' ')] : wrap(text, Math.max(1, width - 2));
    for (const line of content) lines.push({ text: `  ${line}`, dim: entry.kind === 'thinking' || entry.kind === 'tool' || entry.kind === 'event', failed: entry.failed });
  }
  return lines;
}

export function viewport<T>(lines: T[], height: number, top: number | null): T[] {
  const start = top === null ? Math.max(0, lines.length - height) : Math.min(top, Math.max(0, lines.length - height));
  return lines.slice(start, start + height);
}
