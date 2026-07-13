// Parses CC transcript JSONL (sessions.transcript_path) into a small, mobile-friendly shape:
// user prompts, assistant text, tool_use calls, and tool_result outputs. Pure parsing lives in
// parseTranscriptChunk (unit-testable without touching disk); readTranscript does the file I/O
// (fresh tail on first read, byte-offset incremental reads after that).
import { open, stat } from 'node:fs/promises';

export interface TranscriptEntry {
  uuid: string | null;
  kind: 'user' | 'assistant' | 'tool_use' | 'tool_result';
  text: string | null; // user prompt / assistant text / tool_result content
  toolName: string | null; // tool_use only
  toolInput: string | null; // tool_use only — JSON.stringify(input) capped 500 chars
  toolUseId: string | null; // tool_use (block id) and tool_result (tool_use_id) — lets the client pair them
  timestamp: number | null; // epoch ms (Date.parse of the ISO string)
}

// Reads only the tail of the gap when a client reconnects after a long time away — caps the
// worst-case read (and JSON.parse work) per request regardless of how stale afterByte is.
const MAX_READ_BYTES = 1024 * 1024; // 1 MiB

const FILTERED_USER_PREFIXES = ['<command-', '<local-command-', '<system-reminder>'];

interface RawContentBlock {
  type?: string;
  text?: unknown;
  tool_use_id?: unknown;
  content?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
}

interface RawTranscriptLine {
  uuid?: unknown;
  timestamp?: unknown;
  type?: unknown;
  isSidechain?: unknown;
  isMeta?: unknown;
  message?: { content?: unknown };
}

function cap(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function isFilteredUserText(text: string): boolean {
  const trimmed = text.trim();
  return FILTERED_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function parseTimestamp(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

function joinTextBlocks(blocks: RawContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

// tool_result content is either a plain string or an array of {type:'text', text} blocks.
function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return joinTextBlocks(content as RawContentBlock[]);
  return '';
}

/**
 * Pure line-by-line parser for a chunk of transcript JSONL. `skipFirstLine` should be true
 * whenever the chunk was read starting mid-file (tail reads usually begin mid-JSON-object).
 */
export function parseTranscriptChunk(chunk: string, skipFirstLine: boolean): TranscriptEntry[] {
  const lines = chunk.split('\n');
  const entries: TranscriptEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (skipFirstLine && i === 0) continue;
    const line = lines[i].trim();
    if (!line) continue;

    let raw: RawTranscriptLine;
    try {
      raw = JSON.parse(line) as RawTranscriptLine;
    } catch {
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    if (raw.isSidechain === true || raw.isMeta === true) continue;
    if (raw.type !== 'user' && raw.type !== 'assistant') continue;

    const uuid = typeof raw.uuid === 'string' ? raw.uuid : null;
    const timestamp = parseTimestamp(raw.timestamp);
    const content = raw.message?.content;

    if (raw.type === 'user') {
      if (typeof content === 'string') {
        if (content.length > 0 && !isFilteredUserText(content)) {
          entries.push({
            uuid,
            kind: 'user',
            text: cap(content, 4000),
            toolName: null,
            toolInput: null,
            toolUseId: null,
            timestamp,
          });
        }
      } else if (Array.isArray(content)) {
        const blocks = content as RawContentBlock[];
        const joined = joinTextBlocks(blocks);
        if (joined.length > 0 && !isFilteredUserText(joined)) {
          entries.push({
            uuid,
            kind: 'user',
            text: cap(joined, 4000),
            toolName: null,
            toolInput: null,
            toolUseId: null,
            timestamp,
          });
        }
        for (const block of blocks) {
          if (block && block.type === 'tool_result') {
            const text = extractToolResultText(block.content);
            entries.push({
              uuid,
              kind: 'tool_result',
              text: cap(text, 1000),
              toolName: null,
              toolInput: null,
              toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : null,
              timestamp,
            });
          }
        }
      }
    } else {
      // assistant
      if (Array.isArray(content)) {
        const blocks = content as RawContentBlock[];
        const joined = joinTextBlocks(blocks);
        if (joined.length > 0) {
          entries.push({
            uuid,
            kind: 'assistant',
            text: cap(joined, 4000),
            toolName: null,
            toolInput: null,
            toolUseId: null,
            timestamp,
          });
        }
        for (const block of blocks) {
          if (block && block.type === 'tool_use') {
            const toolInput = cap(JSON.stringify(block.input ?? {}), 500);
            entries.push({
              uuid,
              kind: 'tool_use',
              text: null,
              toolName: typeof block.name === 'string' ? block.name : null,
              toolInput,
              toolUseId: typeof block.id === 'string' ? block.id : null,
              timestamp,
            });
          }
          // thinking blocks are intentionally ignored.
        }
      }
    }
  }

  return entries;
}

async function readRange(path: string, start: number, end: number): Promise<string> {
  const length = end - start;
  if (length <= 0) return '';
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    return buf.toString('utf8');
  } finally {
    await handle.close();
  }
}

export async function readTranscript(
  path: string,
  opts: { afterByte?: number; tailBytes: number }
): Promise<{ entries: TranscriptEntry[]; byteOffset: number; truncatedHead: boolean }> {
  const { afterByte, tailBytes } = opts;
  const st = await stat(path);
  const size = st.size;

  if (afterByte !== undefined && afterByte <= size) {
    const gap = size - afterByte;
    let start = afterByte;
    let truncatedHead = false;
    if (gap > MAX_READ_BYTES) {
      start = size - MAX_READ_BYTES;
      truncatedHead = true;
    }
    const chunk = await readRange(path, start, size);
    const entries = parseTranscriptChunk(chunk, truncatedHead);
    return { entries, byteOffset: size, truncatedHead };
  }

  // Fresh tail: no afterByte, or afterByte > size (file replaced/rotated) falls through here.
  const start = Math.max(0, size - tailBytes);
  const truncatedHead = size > tailBytes;
  const chunk = await readRange(path, start, size);
  const entries = parseTranscriptChunk(chunk, truncatedHead);
  return { entries, byteOffset: size, truncatedHead };
}
