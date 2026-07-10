import { statSync } from 'node:fs';
import type Database from 'better-sqlite3';
import type { HubConfig, IClaudeRunner, Logger, MessageRow } from '../types.js';
import { renderChatDeliveryPrompt } from '../core/messageFormat.js';
import * as sessionsRepo from '../db/repo/sessions.js';
import * as messagesRepo from '../db/repo/messages.js';
import * as instancesRepo from '../db/repo/instances.js';

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
  runner: IClaudeRunner;
}

export interface ChatDelivery {
  pokeNow(): void;
  stop(): void;
}

// Hooks only fire on session activity, so a chat message sent to an instance with nothing
// currently running would otherwise never be delivered. This loop polls instances with unread
// mail and starts a brand-new headless session in their project directory to carry it —
// deliberately a fresh spawn rather than `--resume`ing an idle session: an idle terminal never
// repaints for a `--resume` turn either (see Limitations / the UserPromptSubmit FYI re-surface),
// so there's no benefit to resuming one over just starting a clean session.
export function startChatDelivery(deps: ChatDeliveryDeps): ChatDelivery {
  const { db, log, config, runner } = deps;

  let ticking = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Per-instance spawn attempt timestamps, pruned to the trailing hour on read. In-memory only —
  // resets on hub restart, which is fine, the cap just re-opens a little early after one.
  const spawnTimestamps = new Map<string, number[]>();

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

      for (const instance of instancesRepo.list(db)) {
        const unread = messagesRepo.unreadFor(db, instance.name);
        if (unread.length === 0) continue;

        // A mid-turn instance already gets its mail through the normal hooks (Stop urgent-block /
        // next UserPromptSubmit) — this loop only covers instances with nothing currently running.
        if (sessionsRepo.hasActiveSession(db, instance.id)) continue;

        if (runner.runningCwd(instance.cwd)) {
          log.debug('chatDelivery: skip — a hub-spawned turn is already running in this cwd', {
            instance: instance.name,
          });
          continue;
        }

        if (runner.atCapacity()) {
          log.debug('chatDelivery: skip — runner at max concurrent sessions', { instance: instance.name });
          continue;
        }

        try {
          const stat = statSync(instance.cwd);
          if (!stat.isDirectory()) {
            log.warn('chatDelivery: skip — instance cwd is not a directory', {
              instance: instance.name,
              cwd: instance.cwd,
            });
            continue;
          }
        } catch {
          log.warn('chatDelivery: skip — instance cwd does not exist', {
            instance: instance.name,
            cwd: instance.cwd,
          });
          continue;
        }

        // Pruned to the trailing hour on every read — counts attempts, not successes (recorded at
        // dispatch below), so a spawn that never settles can't be used to spawn unboundedly.
        const timestamps = (spawnTimestamps.get(instance.name) ?? []).filter((t) => now - t < HOUR_MS);
        if (timestamps.length >= config.chatDelivery.maxSpawnsPerInstancePerHour) {
          spawnTimestamps.set(instance.name, timestamps);
          log.debug('chatDelivery: skip — hourly spawn cap reached', { instance: instance.name });
          continue;
        }

        // unreadFor returns created_at DESC; reverse so the prompt reads chronologically.
        const ordered = [...unread].reverse();
        // Cap this tick's delivery to a char budget — the full unread set could otherwise render
        // a prompt long enough to blow Windows' argv limit for the spawn below.
        const batch = batchByCharBudget(ordered);
        const messageIds = batch.map((m) => m.id);
        const instanceName = instance.name;
        const cwd = instance.cwd;
        if (batch.length < ordered.length) {
          log.info('chatDelivery: batch smaller than unread set — deferring remainder to a later tick', {
            instance: instanceName,
            batchCount: batch.length,
            deferredCount: ordered.length - batch.length,
          });
        }

        timestamps.push(now);
        spawnTimestamps.set(instanceName, timestamps);

        // Fire-and-forget: mark read once the spawned turn's exit code is known, not at dispatch.
        // In practice this is usually a no-op: the new session's own UserPromptSubmit hook
        // (hooksRoutes.ts) fires mid-turn — recognizing the turn as hub-spawned via
        // runner.runningCwd(cwd) — and already writes the same via='chat_delivery' row first.
        runner
          .startNew({ cwd, prompt: renderChatDeliveryPrompt(batch) })
          .then((result) => {
            if (result.code === 0) {
              messagesRepo.markRead(db, messageIds, instanceName, Date.now(), 'chat_delivery');
              log.info('chatDelivery: delivered', { instance: instanceName, count: messageIds.length });
            } else {
              log.warn('chatDelivery: spawn exited non-zero — leaving messages unread for retry', {
                instance: instanceName,
                code: result.code,
              });
            }
          })
          .catch((err: unknown) => {
            log.warn('chatDelivery: startNew failed', {
              instance: instanceName,
              error: err instanceof Error ? err.message : String(err),
            });
          });
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
