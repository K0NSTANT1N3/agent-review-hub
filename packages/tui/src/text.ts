const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function cleanText(value: string): string {
  // Agent text is untrusted terminal content; remove escape sequences and controls.
  // eslint-disable-next-line no-control-regex
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').replaceAll('\t', '  ');
}

function cellWidth(value: string): number {
  const point = value.codePointAt(0) ?? 0;
  if (/^\p{Mark}+$/u.test(value)) return 0;
  return /\p{Extended_Pictographic}/u.test(value) || point >= 0x1100 && (point <= 0x115f || point >= 0x2e80 && point <= 0xa4cf || point >= 0xac00 && point <= 0xd7a3 || point >= 0xf900 && point <= 0xfaff || point >= 0xfe10 && point <= 0xfe6f || point >= 0xff01 && point <= 0xff60 || point >= 0xffe0 && point <= 0xffe6 || point >= 0x20000) ? 2 : 1;
}

export function widthOf(value: string): number {
  return [...segmenter.segment(cleanText(value))].reduce((width, item) => width + cellWidth(item.segment), 0);
}

export function fit(value: string, width: number): string {
  let result = '';
  let used = 0;
  for (const { segment } of segmenter.segment(cleanText(value).replaceAll('\n', ' '))) {
    const size = cellWidth(segment);
    if (used + size > width) break;
    result += segment;
    used += size;
  }
  return result + ' '.repeat(Math.max(0, width - used));
}

/** Truncate on a space so labels do not cut a word; appends … when anything is dropped. */
export function fitAtWord(value: string, width: number): string {
  const text = cleanText(value).replaceAll('\n', ' ');
  if (widthOf(text) <= width) return text;
  const ellipsis = '…';
  const budget = Math.max(0, width - widthOf(ellipsis));
  let result = '';
  for (const word of text.split(' ')) {
    const next = result === '' ? word : `${result} ${word}`;
    if (widthOf(next) > budget) break;
    result = next;
  }
  if (result === '') return `${fit(text, budget).trimEnd()}${ellipsis}`;
  return `${result}${ellipsis}`;
}

export function wrap(value: string, width: number): string[] {
  const lines: string[] = [];
  for (const line of cleanText(value).split('\n')) {
    let text = '';
    let used = 0;
    for (const { segment } of segmenter.segment(line)) {
      const size = cellWidth(segment);
      if (used + size > Math.max(1, width)) { lines.push(text); text = ''; used = 0; }
      text += segment;
      used += size;
    }
    lines.push(text);
  }
  return lines;
}

export interface Editor { value: string; cursor: number }
export const emptyEditor: Editor = { value: '', cursor: 0 };

export function editText(editor: Editor, input: string, key: { leftArrow?: boolean; rightArrow?: boolean; home?: boolean; end?: boolean; backspace?: boolean; delete?: boolean }, limit = 20_000): Editor {
  const parts = [...segmenter.segment(editor.value)].map((item) => item.segment);
  const cursor = Math.min(editor.cursor, parts.length);
  if (key.leftArrow) return { ...editor, cursor: Math.max(0, cursor - 1) };
  if (key.rightArrow) return { ...editor, cursor: Math.min(parts.length, cursor + 1) };
  if (key.home) return { ...editor, cursor: 0 };
  if (key.end) return { ...editor, cursor: parts.length };
  if (key.backspace) {
    if (cursor === 0) return editor;
    parts.splice(cursor - 1, 1);
    return { value: parts.join(''), cursor: cursor - 1 };
  }
  if (key.delete) { parts.splice(cursor, 1); return { value: parts.join(''), cursor }; }
  const inserted = [...segmenter.segment(cleanText(input).replaceAll('\n', ' '))].map((item) => item.segment);
  parts.splice(cursor, 0, ...inserted);
  if (parts.join('').length > limit) return editor;
  return { value: parts.join(''), cursor: cursor + inserted.length };
}

export function editorLine(editor: Editor, width: number): string {
  const parts = [...segmenter.segment(editor.value)].map((item) => item.segment);
  const before = parts.slice(0, editor.cursor).join('');
  const after = parts.slice(editor.cursor).join('');
  const tail = wrap(before, Math.max(1, width - 1)).at(-1) ?? '';
  return `${tail}▏${after}`;
}
