import type Database from 'better-sqlite3';
import type { HubConfig, Logger, MessageRow } from '../types.js';
import type { HubBus } from '../core/bus.js';
import { readAccessToken } from '../limit/credentials.js';
import * as messagesRepo from '../db/repo/messages.js';

const SUMMARIZE_URL = 'https://api.anthropic.com/v1/messages';
const SUMMARIZE_TIMEOUT_MS = 8000;
const BODY_HEAD_CHARS = 2000;
const MAX_SUMMARY_CHARS = 80;
const BACKFILL_DELAY_MS = 15000;
const BACKFILL_WINDOW_MS = 24 * 60 * 60 * 1000;
const BACKFILL_LIMIT = 50;

const SUMMARIZE_SYSTEM_PROMPT =
  'You summarize a message sent between two coding agents. Reply with ONLY the summary: at most 8 words, ' +
  'telegraphic imperative style, no trailing punctuation. Example: fix meeting card date bug';

export interface MessageSummarizerDeps {
  db: Database.Database;
  bus: HubBus;
  config: HubConfig;
  log: Logger;
}

export interface MessageSummarizer {
  stop(): void;
  // Test hook: resolves once every currently-queued summarize call has settled.
  flush(): Promise<void>;
}

// Same OAuth-authenticated Messages API call as needsInputFilter.classifyNeedsInput, asking a
// small model for an at-most-8-word imperative summary of a chat message body. Never throws —
// any failure (no token, network, timeout, bad/empty response) resolves to null, leaving the
// message's summary column NULL; the statusline falls back to a body snippet in that case.
export async function summarize(
  body: string,
  config: HubConfig,
  log: Logger,
  fetchFn: typeof fetch = fetch
): Promise<string | null> {
  const token = readAccessToken();
  if (!token) {
    log.debug('messageSummarizer: no access token available, skipping summarize');
    return null;
  }

  const truncated = body.length > BODY_HEAD_CHARS ? body.slice(0, BODY_HEAD_CHARS) : body;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUMMARIZE_TIMEOUT_MS);
  try {
    const res = await fetchFn(SUMMARIZE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.summaries.model,
        max_tokens: 30,
        system: SUMMARIZE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: truncated }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      log.debug('messageSummarizer: summarize request failed', { status: res.status });
      return null;
    }

    const json = (await res.json()) as { content?: { text?: string }[] };
    const text = (json.content?.[0]?.text ?? '').trim();
    if (!text) return null;
    return text.length > MAX_SUMMARY_CHARS ? text.slice(0, MAX_SUMMARY_CHARS) : text;
  } catch (err) {
    log.debug('messageSummarizer: summarize request threw', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Fire-and-forget, best-effort summarizer for inter-agent chat messages: subscribes to bus
// 'message' events and asynchronously fills in each message's summary column via a small model.
// Serialized to at most one in-flight API call at a time via a simple promise-chain queue
// (messages are low-volume; no need for concurrency). Never throws across the bus — any failure
// leaves summary NULL, which callers (the statusline) treat as "fall back to a body snippet".
export function startMessageSummarizer(deps: MessageSummarizerDeps): MessageSummarizer {
  const { db, bus, config, log } = deps;

  if (!config.summaries.enabled) {
    return { stop() {}, flush: () => Promise.resolve() };
  }

  let queue: Promise<void> = Promise.resolve();

  function enqueue(row: MessageRow): void {
    queue = queue.then(async () => {
      try {
        const summary = await summarize(row.body, config, log);
        if (summary) messagesRepo.setSummary(db, row.id, summary);
      } catch (err) {
        log.debug('messageSummarizer: failed to summarize message', {
          messageId: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  }

  const unsubscribe = bus.on((e) => {
    if (e.type !== 'message') return;
    if (e.message.summary != null) return;
    enqueue(e.message);
  });

  // Delayed one-shot (mirrors athen's startup backfill) so hub startup isn't competing with a
  // summarization backlog; catches messages that were never summarized (missed events, hub
  // restarts, prior failures).
  const backfillTimer = setTimeout(() => {
    const rows = messagesRepo.listUnsummarized(db, Date.now() - BACKFILL_WINDOW_MS, BACKFILL_LIMIT);
    for (const row of rows) enqueue(row);
  }, BACKFILL_DELAY_MS);
  backfillTimer.unref();

  return {
    stop() {
      unsubscribe();
      clearTimeout(backfillTimer);
    },
    flush: () => queue,
  };
}
