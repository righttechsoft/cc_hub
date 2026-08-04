import { describe, expect, it } from 'vitest';
import { bracketedPaste, sanitize } from './injection.js';

describe('bracketedPaste', () => {
  it('wraps the sanitized body in paste-start/paste-end + submit', () => {
    expect(bracketedPaste('hello')).toBe('\x1b[200~hello\x1b[201~\r');
  });

  it('preserves embedded newlines in a multi-line body', () => {
    expect(bracketedPaste('line one\nline two')).toBe('\x1b[200~line one\nline two\x1b[201~\r');
  });

  it('strips an embedded paste-end marker (breakout guard)', () => {
    expect(bracketedPaste('a\x1b[201~b')).toBe('\x1b[200~ab\x1b[201~\r');
  });

  it('strips control characters from the body', () => {
    expect(bracketedPaste('a\x00b\x07c')).toBe('\x1b[200~abc\x1b[201~\r');
  });

  it('trims trailing newlines/whitespace before the submit', () => {
    expect(bracketedPaste('hello\n\n  \n')).toBe('\x1b[200~hello\x1b[201~\r');
  });

  it('omits the trailing submit CR when submit:false', () => {
    const result = bracketedPaste('x', { submit: false });
    expect(result.endsWith('\x1b[201~')).toBe(true);
    expect(result.endsWith('\r')).toBe(false);
    expect(result).toBe('\x1b[200~x\x1b[201~');
  });

  it('passes a Windows path through unchanged (smart-paste use case)', () => {
    const path = 'C:\\Users\\x\\ccpaste_ab.png';
    expect(sanitize(path)).toBe(path);
    expect(bracketedPaste(path, { submit: false })).toBe(`\x1b[200~${path}\x1b[201~`);
  });
});

describe('sanitize', () => {
  it('leaves plain text unchanged', () => {
    expect(sanitize('hello world')).toBe('hello world');
  });

  it('removes literal paste-end sequences from the body', () => {
    expect(sanitize('before\x1b[201~after')).toBe('beforeafter');
  });

  it('strips C0 control chars except tab and newline', () => {
    expect(sanitize('\x01a\tb\nc\x1fd')).toBe('a\tb\ncd');
  });

  it('strips DEL (0x7f)', () => {
    expect(sanitize('a\x7fb')).toBe('ab');
  });

  it('normalizes CRLF to LF and drops lone CR', () => {
    expect(sanitize('a\r\nb\rc')).toBe('a\nbc');
  });

  it('trims trailing newlines and whitespace', () => {
    expect(sanitize('hello \n \n')).toBe('hello');
  });
});
