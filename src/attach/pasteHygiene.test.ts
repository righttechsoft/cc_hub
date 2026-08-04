import { describe, expect, it } from 'vitest';
import { applyPasteHygiene } from './pasteHygiene.js';

describe('applyPasteHygiene — redact', () => {
  it('redacts an OpenAI/Anthropic-style sk- key', () => {
    const out = applyPasteHygiene('key: sk-abcdefghijklmnopqrstuvwxyz', { redact: true, fence: false });
    expect(out).toBe('key: «REDACTED:api-key»');
  });

  it('redacts an sk-ant- key with its own kind, not the generic api-key kind', () => {
    const out = applyPasteHygiene('key: sk-ant-abcdefghijklmnopqrstuvwxyz', { redact: true, fence: false });
    expect(out).toBe('key: «REDACTED:anthropic-key»');
  });

  it('redacts a GitHub token', () => {
    const out = applyPasteHygiene('token=ghp_abcdefghijklmnopqrstuvwxyz1234', { redact: true, fence: false });
    expect(out).toBe('token=«REDACTED:github-token»');
  });

  it('redacts an AWS access key id', () => {
    const out = applyPasteHygiene('AKIAABCDEFGHIJKLMNOP', { redact: true, fence: false });
    expect(out).toBe('«REDACTED:aws-key»');
  });

  it('redacts a Slack token', () => {
    const out = applyPasteHygiene('xoxb-1234567890-abcdefghij', { redact: true, fence: false });
    expect(out).toBe('«REDACTED:slack-token»');
  });

  it('redacts a Google API key', () => {
    const key = 'AIza' + 'a'.repeat(35);
    const out = applyPasteHygiene(key, { redact: true, fence: false });
    expect(out).toBe('«REDACTED:google-key»');
  });

  it('redacts a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const out = applyPasteHygiene(`Authorization: Bearer ${jwt}`, { redact: true, fence: false });
    expect(out).toBe('Authorization: Bearer «REDACTED:jwt»');
  });

  it('redacts a whole PEM private key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJBAK...\nmore lines here\n-----END RSA PRIVATE KEY-----';
    const out = applyPasteHygiene(`before\n${pem}\nafter`, { redact: true, fence: false });
    expect(out).toBe('before\n«REDACTED:private-key»\nafter');
  });

  it('redacts a real-looking multi-secret blob, each with its own kind', () => {
    const text = [
      'OPENAI_KEY=sk-abcdefghijklmnopqrstuvwxyz',
      'ANTHROPIC_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz',
      'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz1234',
      'AWS_KEY=AKIAABCDEFGHIJKLMNOP',
    ].join('\n');
    const out = applyPasteHygiene(text, { redact: true, fence: false });
    expect(out).toBe(
      [
        'OPENAI_KEY=«REDACTED:api-key»',
        'ANTHROPIC_KEY=«REDACTED:anthropic-key»',
        'GITHUB_TOKEN=«REDACTED:github-token»',
        'AWS_KEY=«REDACTED:aws-key»',
      ].join('\n')
    );
  });

  it('leaves plain prose unchanged when redact is false', () => {
    const text = 'my key is sk-abcdefghijklmnopqrstuvwxyz, keep it secret';
    expect(applyPasteHygiene(text, { redact: false, fence: false })).toBe(text);
  });
});

describe('applyPasteHygiene — fence', () => {
  it('does not fence plain prose (no code signal)', () => {
    const text = 'Hey, just checking in.\nHow is the project going?\nLet me know when you have a minute.';
    expect(applyPasteHygiene(text, { redact: false, fence: true })).toBe(text);
  });

  it('fences a multi-line code snippet', () => {
    const code = 'function add(a, b) {\n  return a + b;\n}';
    const out = applyPasteHygiene(code, { redact: false, fence: true });
    expect(out).toBe('```\n' + code + '\n```');
  });

  it('does not double-wrap text that is already fenced', () => {
    const already = '```\nfunction add(a, b) {\n  return a + b;\n}\n```';
    expect(applyPasteHygiene(already, { redact: false, fence: true })).toBe(already);
  });

  it('does not fence single-line or two-line text even if code-like', () => {
    const oneLine = 'const x = 1;';
    expect(applyPasteHygiene(oneLine, { redact: false, fence: true })).toBe(oneLine);
  });
});

describe('applyPasteHygiene — ordering and identity', () => {
  it('redacts before fencing, so a fenced code block is also redacted', () => {
    const code = 'const key = "sk-abcdefghijklmnopqrstuvwxyz";\nfunction load() {\n  return key;\n}';
    const out = applyPasteHygiene(code, { redact: true, fence: true });
    expect(out).toContain('«REDACTED:api-key»');
    expect(out).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(out.startsWith('```\n')).toBe(true);
    expect(out.endsWith('\n```')).toBe(true);
  });

  it('returns the text unchanged when both options are false', () => {
    const text = 'sk-abcdefghijklmnopqrstuvwxyz\nfunction f() {\n  return 1;\n}';
    expect(applyPasteHygiene(text, { redact: false, fence: false })).toBe(text);
  });
});
