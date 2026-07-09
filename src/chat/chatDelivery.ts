import type Database from 'better-sqlite3';
import type { HubConfig, IPromptDelivery, Logger, MessageRow } from '../types.js';
import { renderChatDeliveryPrompt } from '../core/messageFormat.js';
import * as sessionsRepo from '../db/repo/sessions.js';
import * as messagesRepo from '../db/repo/messages.js';
import * as promptsRepo from '../db/repo/prompts.js';

const HOUR_MS = 60 * 60 * 1000;
// Windows CreateProcess argv limit is ~32K; prompt is a single -p argument.
const MAX_BATCH_CHARS = 20000;

// Accumulates messages (already in chronological order) up to a character budget, so the
// rendered prompt can't blow past Windows' argv limit when many messages are unread at once.
// Always includes at least the first message, even if it alone exceeds the budget — the guard
// is only meant to cap accumulation across multiple messages.
function batchByCharBudget(messages: MessageRow[]): MessageRow[] {
  const batch: MessageRow[] = [];
  let totalChars = 0;
  for (const msg of messages) {
    if (batch.length > 0 && totalChars + msg.body.length > MAX_BATCH_CHARS) break;
    batch.push(msg);
    totalChars += msg.body.length;
  }
  return batch;
}

export interface ChatDeliveryDeps {
  db: Database.Database;
  log: Logger;
  config: HubConfig;
  delivery: IPromptDelivery;
}

export interface ChatDelivery {
  pokeNow(): void;
  stop(): void;
}

// Hooks only fire on session activity, so a chat message sent while the recipient session is
// idle would otherwise never be delivered. This loop polls for idle sessions with unread mail
// and spawns a headless turn carrying them, mirroring the limit watcher's scheduling shape.
export function startChatDelivery(deps: ChatDeliveryDeps): ChatDelivery {
  const { db, log, config, delivery } = deps;

  let ticking = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function scheduleNext(delayMs: number): void {
    if (stopped) return;
    clearTimer();
    timer = setTimeout(() => {
      void tick();
    }, delayMs);
  }

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const now = Date.now();
      const idle = sessionsRepo.listJoined(db, { status: ['idle'] });
      // Sessions are ordered last_event_at DESC (per listJoined), so the first idle session seen
      // per instance is its most recent one — one delivery per instance per tick.
      const seen = new Set<string>();

      for (const session of idle) {
        if (!session.instance_name || seen.has(session.instance_name)) continue;
        seen.add(session.instance_name);

        // <= 0 means no age limit — any idle session stays reachable however long it's been idle.
        if (
          config.chatDelivery.maxSessionIdleAgeMinutes > 0 &&
          now - session.last_event_at > config.chatDelivery.maxSessionIdleAgeMinutes * 60_000
        ) {
          continue; // stale session, skip
        }

        // 0 disables the gate (default): deliveries may spawn while a human sits at the terminal;
        // the UserPromptSubmit FYI re-surface covers that case.
        if (now - session.last_event_at < config.chatDelivery.minIdleMinutes * 60_000) {
          log.debug('chatDelivery: skip — session too recently active, human likely at terminal', {
            session: session.id,
            instance: session.instance_name,
          });
          continue;
        }

        const unread = messagesRepo.unreadFor(db, session.instance_name);
        if (unread.length === 0) continue;

        if (
          promptsRepo.countBySourceSince(db, session.id, 'chat', now - HOUR_MS) >=
          config.chatDelivery.maxPerSessionPerHour
        ) {
          log.debug('chatDelivery: skip — hourly cap reached', {
            session: session.id,
            instance: session.instance_name,
          });
          continue;
        }

        try {
          // unreadFor returns created_at DESC; reverse so the prompt reads chronologically.
          const ordered = [...unread].reverse();
          // Cap this tick's delivery to a char budget — the full unread set could otherwise
          // render a prompt long enough to blow Windows' argv limit for the spawn below.
          const batch = batchByCharBudget(ordered);
          const messageIds = batch.map((m) => m.id);
          const instanceName = session.instance_name;
          if (batch.length < ordered.length) {
            log.info('chatDelivery: batch smaller than unread set — deferring remainder to a later tick', {
              session: session.id,
              instance: instanceName,
              batchCount: batch.length,
              deferredCount: ordered.length - batch.length,
            });
          }
          // send() resolves as soon as the spawn is dispatched, not once it succeeds (resumePrompt
          // runs fire-and-forget inside it) — so for a 'spawned' delivery we must wait for the
          // onSettled callback (invoked from send()'s own .then/.catch once the turn actually
          // finishes) before marking messages read. A 'queued' delivery is durably persisted in
          // the prompt queue regardless of runner state, so it's safe to mark read immediately.
          const result = await delivery.send(session.id, renderChatDeliveryPrompt(batch), 'chat', (ok) => {
            if (ok) {
              // In the common case, the headless turn's own UserPromptSubmit hook
              // (hooksRoutes.ts handleUserPromptSubmit) already marked these same messages read
              // with via='chat_delivery' while runner.isRunning(session.id) was true — this call
              // then hits INSERT OR IGNORE against an existing, already-correctly-tagged row and
              // is a no-op. It still matters as a fallback for the rare turn that never reaches
              // UserPromptSubmit (e.g. spawn errors before CC starts processing the prompt).
              messagesRepo.markRead(db, messageIds, instanceName, Date.now(), 'chat_delivery');
              log.info('chatDelivery: delivered', {
                session: session.id,
                instance: instanceName,
                count: messageIds.length,
              });
            } else {
              log.warn('chatDelivery: spawn failed after dispatch — leaving messages unread for retry', {
                session: session.id,
                instance: instanceName,
              });
            }
          });
          if (result.delivery === 'queued') {
            messagesRepo.markRead(db, messageIds, instanceName, now, 'chat_delivery');
            log.info('chatDelivery: delivered', {
              session: session.id,
              instance: instanceName,
              count: messageIds.length,
              delivery: result.delivery,
            });
          }
        } catch (err) {
          log.warn('chatDelivery: send failed', { session: session.id, error: String(err) });
        }
      }
    } catch (err) {
      // tick() is always invoked fire-and-forget (`void tick()`), so any exception here would
      // otherwise become an unhandled rejection that crashes the whole always-on hub process.
      log.error('chatDelivery: tick() threw unexpectedly', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      ticking = false;
      scheduleNext(config.chatDelivery.tickMs);
    }
  }

  function pokeNow(): void {
    if (ticking) return;
    clearTimer();
    void tick();
  }

  function stop(): void {
    stopped = true;
    clearTimer();
  }

  const chatDelivery = {
    pokeNow,
    stop,
    _tick: tick,
  };

  scheduleNext(config.chatDelivery.tickMs);

  return chatDelivery;
}
