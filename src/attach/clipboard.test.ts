import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parseClipboardOutput, readClipboardForPaste } from './clipboard.js';

const execFileAsync = promisify(execFile);

describe('parseClipboardOutput', () => {
  it('parses kind\\0value into a text paste, preserving embedded newlines', () => {
    expect(parseClipboardOutput('text\u0000hello\nworld')).toEqual({ kind: 'text', value: 'hello\nworld' });
  });

  it('trims a trailing CRLF for image/file kinds but not text', () => {
    expect(parseClipboardOutput('file\u0000C:\\a\\b.png\r\n')).toEqual({ kind: 'file', value: 'C:\\a\\b.png' });
    expect(parseClipboardOutput('text\u0000hello\r\n')).toEqual({ kind: 'text', value: 'hello\r\n' });
  });

  it('returns null when there is no NUL separator', () => {
    expect(parseClipboardOutput('')).toBeNull();
    expect(parseClipboardOutput('nothing here')).toBeNull();
  });

  it('returns null for an unrecognized kind', () => {
    expect(parseClipboardOutput('bogus\u0000value')).toBeNull();
  });

  it('returns null when the value is empty', () => {
    expect(parseClipboardOutput('text\u0000')).toBeNull();
  });
});

describe.skipIf(process.platform !== 'win32')('readClipboardForPaste (Windows)', () => {
  it('round-trips text set via Set-Clipboard', async () => {
    await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', "Set-Clipboard -Value 'cchub_test_123'"]);
    const result = await readClipboardForPaste();
    expect(result).toEqual({ kind: 'text', value: 'cchub_test_123' });
  });
});

describe.skipIf(process.platform === 'win32')('readClipboardForPaste (non-Windows)', () => {
  it('returns null', async () => {
    expect(await readClipboardForPaste()).toBeNull();
  });
});
