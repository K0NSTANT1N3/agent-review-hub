import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { cleanText, editText, editorLine, emptyEditor, fit, fitAtWord, widthOf, wrap } from '../src/text.js';
import { registerTerminalCleanup } from '../src/terminal.js';

describe('terminal text', () => {
  it('strips remote terminal escape sequences, hyperlinks, controls and handles wide/combining characters', () => {
    expect(cleanText('\u001b[31mred\u001b[0m\u0007\u001b]8;;https://evil.test\u0007link\u001b]8;;\u0007')).toBe('redlink');
    expect(widthOf('你e\u0301')).toBe(3);
    expect(fit('你e\u0301x', 3)).toBe('你e\u0301');
    expect(fitAtWord('also: codex 0.163.0, pi 1.3.0', 21)).toBe('also: codex 0.163.0,…');
    expect(fitAtWord('also: codex 0.163.0', 40)).toBe('also: codex 0.163.0');
    expect(wrap('你你ab\nc', 3)).toEqual(['你', '你a', 'b', 'c']);
  });

  it('edits graphemes with arrows, home/end, delete/backspace and a length cap', () => {
    let editor = editText(emptyEditor, 'a🙂b', {});
    editor = editText(editor, '', { leftArrow: true });
    editor = editText(editor, '', { backspace: true });
    expect(editor).toEqual({ value: 'ab', cursor: 1 });
    editor = editText(editor, 'X', {});
    expect(editor.value).toBe('aXb');
    editor = editText(editor, '', { home: true });
    editor = editText(editor, '', { delete: true });
    expect(editor).toEqual({ value: 'Xb', cursor: 0 });
    editor = editText(editor, '', { end: true });
    expect(editText(editor, 'long', {}, 3)).toEqual(editor);
    expect(editorLine(editor, 10)).toBe('Xb▏');
    expect(editText(emptyEditor, 'a\nb', {}).value).toBe('a b');
  });
});

it('unmounts on SIGINT/SIGTERM so Ink restores alternate screen and raw mode; removes listeners', () => {
  const target = new EventEmitter();
  const unmount = vi.fn();
  const remove = registerTerminalCleanup({ unmount }, target as unknown as NodeJS.Process);
  target.emit('SIGINT');
  target.emit('SIGTERM');
  expect(unmount).toHaveBeenCalledTimes(2);
  remove();
  expect(target.listenerCount('SIGINT')).toBe(0);
  expect(target.listenerCount('SIGTERM')).toBe(0);
});

it('unmounts on SIGHUP and on a crash before exiting, so the shell is never left in raw mode', () => {
  const target = Object.assign(new EventEmitter(), { exit: vi.fn() });
  const order: string[] = [];
  const unmount = vi.fn(() => { order.push('unmount'); });
  const stderr = { write: vi.fn(() => { order.push('report'); return true; }) };
  target.exit.mockImplementation(() => { order.push('exit'); });
  const remove = registerTerminalCleanup({ unmount }, target as unknown as NodeJS.Process, stderr);
  target.emit('SIGHUP');
  expect(unmount).toHaveBeenCalledTimes(1);
  target.emit('uncaughtException', new Error('stream handler threw'));
  target.emit('unhandledRejection', 'rejected');
  expect(order).toEqual(['unmount', 'unmount', 'report', 'exit', 'unmount', 'report', 'exit']);
  expect(target.exit).toHaveBeenCalledWith(1);
  expect(String(stderr.write.mock.calls[0])).toContain('stream handler threw');
  remove();
  for (const event of ['SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException', 'unhandledRejection']) expect(target.listenerCount(event)).toBe(0);
});
