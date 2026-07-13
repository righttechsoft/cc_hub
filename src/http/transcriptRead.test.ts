import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTranscriptChunk, readTranscript } from './transcriptRead.js';

function line(obj: unknown): string {
  return JSON.stringify(obj);
}

describe('parseTranscriptChunk', () => {
  it('parses a string-content user prompt', () => {
    const chunk = line({ uuid: 'u1', type: 'user', timestamp: '2024-01-01T00:00:00.000Z', message: { content: 'hello there' } });
    const entries = parseTranscriptChunk(chunk, false);
    expect(entries).toEqual([
      {
        uuid: 'u1',
        kind: 'user',
        text: 'hello there',
        toolName: null,
        toolInput: null,
        toolUseId: null,
        timestamp: Date.parse('2024-01-01T00:00:00.000Z'),
      },
    ]);
  });

  it('parses array user content with text blocks joined, plus a string-content tool_result', () => {
    const chunk = line({
      uuid: 'u2',
      type: 'user',
      timestamp: '2024-01-01T00:00:00.000Z',
      message: {
        content: [
          { type: 'text', text: 'part one' },
          { type: 'text', text: 'part two' },
          { type: 'tool_result', tool_use_id: 'tu1', content: 'the result string' },
        ],
      },
    });
    const entries = parseTranscriptChunk(chunk, false);
    expect(entries).toEqual([
      {
        uuid: 'u2',
        kind: 'user',
        text: 'part one\npart two',
        toolName: null,
        toolInput: null,
        toolUseId: null,
        timestamp: Date.parse('2024-01-01T00:00:00.000Z'),
      },
      {
        uuid: 'u2',
        kind: 'tool_result',
        text: 'the result string',
        toolName: null,
        toolInput: null,
        toolUseId: 'tu1',
        timestamp: Date.parse('2024-01-01T00:00:00.000Z'),
      },
    ]);
  });

  it('parses a tool_result with block-array content, joining its text blocks', () => {
    const chunk = line({
      uuid: 'u3',
      type: 'user',
      timestamp: null,
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tu2', content: [{ type: 'text', text: 'line a' }, { type: 'text', text: 'line b' }] },
        ],
      },
    });
    const entries = parseTranscriptChunk(chunk, false);
    expect(entries).toEqual([
      {
        uuid: 'u3',
        kind: 'tool_result',
        text: 'line a\nline b',
        toolName: null,
        toolInput: null,
        toolUseId: 'tu2',
        timestamp: null,
      },
    ]);
  });

  it('parses assistant text plus 2 tool_use blocks, preserving order and mapping ids', () => {
    const chunk = line({
      uuid: 'a1',
      type: 'assistant',
      timestamp: '2024-01-01T00:00:00.000Z',
      message: {
        content: [
          { type: 'text', text: 'thinking out loud' },
          { type: 'tool_use', id: 'call-1', name: 'Read', input: { file: 'a.ts' } },
          { type: 'tool_use', id: 'call-2', name: 'Write', input: { file: 'b.ts' } },
        ],
      },
    });
    const entries = parseTranscriptChunk(chunk, false);
    expect(entries).toEqual([
      {
        uuid: 'a1',
        kind: 'assistant',
        text: 'thinking out loud',
        toolName: null,
        toolInput: null,
        toolUseId: null,
        timestamp: Date.parse('2024-01-01T00:00:00.000Z'),
      },
      {
        uuid: 'a1',
        kind: 'tool_use',
        text: null,
        toolName: 'Read',
        toolInput: JSON.stringify({ file: 'a.ts' }),
        toolUseId: 'call-1',
        timestamp: Date.parse('2024-01-01T00:00:00.000Z'),
      },
      {
        uuid: 'a1',
        kind: 'tool_use',
        text: null,
        toolName: 'Write',
        toolInput: JSON.stringify({ file: 'b.ts' }),
        toolUseId: 'call-2',
        timestamp: Date.parse('2024-01-01T00:00:00.000Z'),
      },
    ]);
  });

  it('skips a thinking-only assistant entry (no text, no tool_use)', () => {
    const chunk = line({
      uuid: 'a2',
      type: 'assistant',
      timestamp: '2024-01-01T00:00:00.000Z',
      message: { content: [{ type: 'thinking', thinking: 'pondering...' }] },
    });
    expect(parseTranscriptChunk(chunk, false)).toEqual([]);
  });

  it('skips sidechain, isMeta, and non-user/assistant type entries', () => {
    const lines = [
      line({ uuid: 's1', type: 'user', isSidechain: true, message: { content: 'sidechain prompt' } }),
      line({ uuid: 's2', type: 'user', isMeta: true, message: { content: 'meta prompt' } }),
      line({ uuid: 's3', type: 'system', message: { content: 'system line' } }),
      line({ uuid: 's4', type: 'summary', message: { content: 'summary line' } }),
    ];
    expect(parseTranscriptChunk(lines.join('\n'), false)).toEqual([]);
  });

  it('skips user entries starting with <command-, <local-command-, or <system-reminder>', () => {
    const lines = [
      line({ uuid: 'c1', type: 'user', message: { content: '<command-name>foo</command-name>' } }),
      line({ uuid: 'c2', type: 'user', message: { content: '<local-command-stdout>bar</local-command-stdout>' } }),
      line({ uuid: 'c3', type: 'user', message: { content: '<system-reminder>baz</system-reminder>' } }),
      line({ uuid: 'c4', type: 'user', message: { content: '  <command-name>leading whitespace</command-name>' } }),
    ];
    expect(parseTranscriptChunk(lines.join('\n'), false)).toEqual([]);
  });

  it('caps user/assistant text at 4000 chars and tool_result at 1000, appending an ellipsis', () => {
    const longUser = 'u'.repeat(5000);
    const longToolResult = 'r'.repeat(2000);
    const chunk = [
      line({ uuid: 'cap1', type: 'user', message: { content: longUser } }),
      line({
        uuid: 'cap2',
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 't', content: longToolResult }] },
      }),
    ].join('\n');
    const entries = parseTranscriptChunk(chunk, false);
    expect(entries[0].text).toHaveLength(4001);
    expect(entries[0].text?.endsWith('…')).toBe(true);
    expect(entries[1].text).toHaveLength(1001);
    expect(entries[1].text?.endsWith('…')).toBe(true);
  });

  it('caps toolInput at 500 chars', () => {
    const chunk = line({
      uuid: 'a3',
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'call-x', name: 'Big', input: { blob: 'x'.repeat(1000) } }],
      },
    });
    const entries = parseTranscriptChunk(chunk, false);
    expect(entries[0].toolInput).toHaveLength(501);
    expect(entries[0].toolInput?.endsWith('…')).toBe(true);
  });

  it('drops the first line unconditionally when skipFirstLine is true, even if it is valid JSON', () => {
    const chunk = [
      line({ uuid: 'first', type: 'user', message: { content: 'first prompt' } }),
      line({ uuid: 'second', type: 'user', message: { content: 'second prompt' } }),
    ].join('\n');

    const withoutSkip = parseTranscriptChunk(chunk, false);
    expect(withoutSkip).toHaveLength(2);

    const withSkip = parseTranscriptChunk(chunk, true);
    expect(withSkip).toHaveLength(1);
    expect(withSkip[0].uuid).toBe('second');
  });
});

describe('readTranscript', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-hub-transcript-read-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fresh tail on a small file: truncatedHead false, byteOffset = size', async () => {
    const path = join(dir, 'small.jsonl');
    const lines = [
      line({ uuid: 'x1', type: 'user', message: { content: 'first prompt' } }),
      line({ uuid: 'x2', type: 'assistant', message: { content: [{ type: 'text', text: 'first reply' }] } }),
    ];
    writeFileSync(path, lines.join('\n') + '\n', 'utf8');

    const result = await readTranscript(path, { tailBytes: 262144 });
    expect(result.truncatedHead).toBe(false);
    expect(result.entries).toHaveLength(2);
    expect(result.byteOffset).toBe(statSync(path).size);
  });

  it('afterByte incremental read returns only newly appended entries', async () => {
    const path = join(dir, 'incremental.jsonl');
    writeFileSync(path, line({ uuid: 'y1', type: 'user', message: { content: 'prompt one' } }) + '\n', 'utf8');

    const first = await readTranscript(path, { tailBytes: 262144 });
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0].uuid).toBe('y1');

    appendFileSync(path, line({ uuid: 'y2', type: 'user', message: { content: 'prompt two' } }) + '\n', 'utf8');

    const second = await readTranscript(path, { afterByte: first.byteOffset, tailBytes: 262144 });
    expect(second.entries).toHaveLength(1);
    expect(second.entries[0].uuid).toBe('y2');
    expect(second.truncatedHead).toBe(false);
    expect(second.byteOffset).toBe(statSync(path).size);
  });

  it('falls back to a fresh tail when afterByte exceeds the current file size', async () => {
    const path = join(dir, 'rotated.jsonl');
    writeFileSync(path, line({ uuid: 'z1', type: 'user', message: { content: 'rotated prompt' } }) + '\n', 'utf8');

    const size = statSync(path).size;

    const result = await readTranscript(path, { afterByte: size + 1000, tailBytes: 262144 });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].uuid).toBe('z1');
    expect(result.byteOffset).toBe(size);
  });
});
