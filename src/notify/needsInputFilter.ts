import { open, stat } from 'node:fs/promises';
import type { HubConfig, Logger } from '../types.js';
import { readAccessToken } from '../limit/credentials.js';

const TAIL_BYTES = 64 * 1024;
const CLASSIFY_TIMEOUT_MS = 8000;
const TEXT_TAIL_CHARS = 2000;
const CLASSIFY_URL = 'https://api.anthropic.com/v1/messages';

const CLASSIFY_SYSTEM_PROMPT =
  'You classify the final message an AI coding assistant sent before going idle. Answer YES if the message ' +
  'asks the human a question, requests a decision, or otherwise requires the human to act now. Answer NO if ' +
  'it is a status update, a completion report, or says background work will continue and report back. Answer ' +
  'only YES or NO.';

interface TranscriptTextBlock {
  type: string;
  text?: string;
}

interface TranscriptEntry {
  type?: string;
  isSidechain?: boolean;
  message?: { content?: unknown };
}

// Walks a transcript tail (JSONL, newest last) backwards for the newest non-sidechain assistant
// message whose content includes at least one text block, and returns its text (joined if there
// are several). Pure/unit-testable — the tail's first line is usually truncated mid-JSON, so
// unparseable lines are skipped rather than treated as evidence either way (mirrors the pattern
// in src/limit/transcriptScan.ts).
export function parseLastAssistantText(tail: string): string | null {
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;

    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }

    if (entry.isSidechain === true) continue;
    if (entry.type !== 'assistant') continue;

    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;

    const texts = (content as TranscriptTextBlock[])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.length > 0)
      .map((b) => b.text as string);
    if (texts.length === 0) continue; // e.g. a tool_use-only assistant turn — keep walking back

    return texts.join('\n');
  }
  return null;
}

async function readTail(path: string, size: number): Promise<string> {
  const len = Math.min(size, TAIL_BYTES);
  if (len === 0) return '';
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

async function readLastAssistantText(transcriptPath: string): Promise<string | null> {
  const st = await stat(transcriptPath);
  const tail = await readTail(transcriptPath, st.size);
  return parseLastAssistantText(tail);
}

export type IdleVerdict = 'needs_input' | 'no_action' | 'unknown';

// Asks a small model whether the given (already-extracted) assistant text needs a human's
// attention right now. Never throws — any failure (no token, network, timeout, bad response)
// degrades to 'unknown', which the caller treats the same as "needs input" (fail-open).
export async function classifyNeedsInput(
  text: string,
  config: HubConfig,
  log: Logger,
  fetchFn: typeof fetch = fetch
): Promise<IdleVerdict> {
  const token = readAccessToken();
  if (!token) {
    log.debug('needsInputFilter: no access token available, skipping classification');
    return 'unknown';
  }

  // The ending is what signals a question ("...so — should I proceed?") — truncate from the tail.
  const truncated = text.length > TEXT_TAIL_CHARS ? text.slice(-TEXT_TAIL_CHARS) : text;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLASSIFY_TIMEOUT_MS);
  try {
    const res = await fetchFn(CLASSIFY_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.notifications.aiIdleFilterModel,
        max_tokens: 5,
        system: CLASSIFY_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: truncated }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      log.debug('needsInputFilter: classify request failed', { status: res.status });
      return 'unknown';
    }

    const json = (await res.json()) as { content?: { text?: string }[] };
    const answer = (json.content?.[0]?.text ?? '').trim().toUpperCase();
    if (answer.startsWith('YES')) return 'needs_input';
    if (answer.startsWith('NO')) return 'no_action';
    log.debug('needsInputFilter: unrecognized classify response', { answer });
    return 'unknown';
  } catch (err) {
    log.debug('needsInputFilter: classify request threw', { error: err instanceof Error ? err.message : String(err) });
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

// Single entry point both notifiers call for an idle_prompt Notification. Fail-open by contract:
// anything short of a clean "no action needed" verdict returns true (notify) — a broken filter
// must degrade to notifying, never to silence.
export async function shouldNotifyIdlePrompt(
  transcriptPath: string | null,
  config: HubConfig,
  log: Logger,
  fetchFn: typeof fetch = fetch,
  sessionId?: string
): Promise<boolean> {
  if (!transcriptPath) return true;

  let text: string | null;
  try {
    text = await readLastAssistantText(transcriptPath);
  } catch (err) {
    log.debug('needsInputFilter: failed to read transcript', {
      transcriptPath,
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
  if (!text) return true;

  const verdict = await classifyNeedsInput(text, config, log, fetchFn);
  if (verdict !== 'no_action') return true;

  log.info('needsInputFilter: suppressed idle_prompt — no action needed', sessionId ? { sessionId } : undefined);
  return false;
}
