// Stale-session reaper. Force-killed or crashed terminals never fire a SessionEnd hook, so their
// sessions stay non-'ended' (usually 'idle') forever — live evidence surfaced two distinct bugs
// from this (see CLAUDE.md): a 21-day-old session still rendering with the LIVE badge in the
// admin Sessions tab, and hub_register's tier-3 "sole active named session in this cwd" rule
// hitting false ambiguity (two 'idle' named sessions in one cwd, one of them long dead), silently
// dropping a dispatched agent's identity back to the folder default.
//
// This tick periodically marks a session 'ended' once BOTH: it's been quiet for
// config.sessions.staleAfterMinutes, AND its instance has no attached cc-attach wrapper right
// now. The attached-wrapper exemption is the whole point — an open terminal that's simply idle
// (a human stepped away) must NEVER be reaped no matter how long it's been quiet; only a session
// with nothing listening on the other end is "stale" in the sense this reaper cares about.
import type Database from 'better-sqlite3';
import type { HubConfig, IAttachRegistry, IClaudeRunner, Logger } from '../types.js';
import * as sessionsRepo from '../db/repo/sessions.js';

export interface SessionReaperDeps {
  db: Database.Database;
  log: Logger;
  config: HubConfig;
  attach: IAttachRegistry;
  runner: IClaudeRunner;
}

export interface SessionReaper {
  stop(): void;
}

// Cap on how many reaped ids get logged per tick — a large batch (e.g. after the reaper was
// disabled/down for a while) must not spam the log with hundreds of ids.
const LOG_ID_CAP = 10;

export function startSessionReaper(deps: SessionReaperDeps): SessionReaper {
  const { db, log, config, attach, runner } = deps;

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
    timer.unref();
  }

  // An open cc-attach terminal for this session's instance — by resolved name first (several
  // named siblings can share a cwd, see src/attach/attachRegistry.ts), falling back to the
  // cwd-keyed lookup for the common unnamed case or when instance_name is unavailable.
  function hasAttachedWrapper(cwd: string, instanceName: string | null): boolean {
    const byName = instanceName ? attach.getByName?.(instanceName) : undefined;
    return (byName ?? attach.get(cwd)) !== undefined;
  }

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const now = Date.now();
      const staleMs = config.sessions.staleAfterMinutes * 60_000;
      const candidates = sessionsRepo.listStale(db, staleMs);
      const reapedIds: string[] = [];

      for (const session of candidates) {
        if (hasAttachedWrapper(session.cwd, session.instance_name)) continue;
        if (runner.isRunning(session.id) || runner.runningCwd(session.cwd)) continue;
        sessionsRepo.setStatus(db, session.id, 'ended', now);
        reapedIds.push(session.id);
      }

      if (reapedIds.length > 0) {
        log.info(`sessions reaper: ended ${reapedIds.length} stale sessions`, {
          ids: reapedIds.slice(0, LOG_ID_CAP),
        });
      }
    } catch (err) {
      // tick() always runs fire-and-forget (`void tick()`) — an uncaught throw here would
      // otherwise surface as an unhandled rejection and could crash the always-on hub process.
      log.error('sessions reaper: tick() threw unexpectedly', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      ticking = false;
      scheduleNext(config.sessions.reapIntervalMs);
    }
  }

  function stop(): void {
    stopped = true;
    clearTimer();
  }

  const reaper = {
    stop,
    // Test hook (mirrors src/chat/chatDelivery.ts's `_tick`): lets tests drive one pass
    // synchronously instead of waiting on the real interval.
    _tick: tick,
  };

  scheduleNext(config.sessions.reapIntervalMs);

  return reaper;
}
