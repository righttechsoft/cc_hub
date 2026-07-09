import type Database from 'better-sqlite3';
import type {
  HubConfig,
  ILimitWatcher,
  IContinuationRunner,
  LimitStateName,
  LimitStateRow,
  Logger,
  Usage,
} from '../types.js';
import { HubBus } from '../core/bus.js';
import { fetchUsage, UsageError } from './usageClient.js';
import { readAccessToken } from './credentials.js';
import { scanTranscriptsForLimitHits } from './transcriptScan.js';
import * as sessions from '../db/repo/sessions.js';
import * as limitRepo from '../db/repo/limit.js';

const FIVE_MIN_MS = 5 * 60 * 1000;

export interface WatcherIo {
  fetchUsage?: typeof fetchUsage;
  readAccessToken?: typeof readAccessToken;
  scanTranscripts?: typeof scanTranscriptsForLimitHits;
  now?: () => number;
}

export interface WatcherDeps {
  db: Database.Database;
  config: HubConfig;
  bus: HubBus;
  log: Logger;
  continuation: IContinuationRunner;
  io?: WatcherIo;
}

type PollResult = { ok: true; usage: Usage } | { ok: false; error: UsageError };

export function startLimitWatcher(deps: WatcherDeps): ILimitWatcher {
  const { db, config, bus, log, continuation } = deps;
  const io = {
    fetchUsage: deps.io?.fetchUsage ?? fetchUsage,
    readAccessToken: deps.io?.readAccessToken ?? readAccessToken,
    scanTranscripts: deps.io?.scanTranscripts ?? scanTranscriptsForLimitHits,
    now: deps.io?.now ?? Date.now,
  };

  let currentState: LimitStateName = 'unknown';
  let lastUtilization: number | null = null;
  let lastResetsAt: number | null = null;
  let lastOkPollAt: number | null = null;
  let lastTickAt = 0;
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
    if (stopped || !config.limitWatcher.enabled) return;
    clearTimer();
    timer = setTimeout(() => {
      void tick();
    }, delayMs);
  }

  function buildRow(now: number, error: string | null): LimitStateRow {
    return {
      id: 1,
      state: currentState,
      utilization: lastUtilization,
      resets_at: lastResetsAt,
      last_poll_at: now,
      last_ok_poll_at: lastOkPollAt,
      error,
    };
  }

  function persistAndEmit(now: number, error: string | null): void {
    const row = buildRow(now, error);
    limitRepo.patchState(db, {
      state: row.state,
      utilization: row.utilization,
      resets_at: row.resets_at,
      last_poll_at: row.last_poll_at,
      last_ok_poll_at: row.last_ok_poll_at,
      error: row.error,
    });
    bus.emit({ type: 'limit_state', state: row });
  }

  async function attemptFetch(): Promise<PollResult> {
    const token = io.readAccessToken();
    if (token === null) {
      return { ok: false, error: new UsageError('auth', 'no access token available in credentials file') };
    }
    try {
      const usage = await io.fetchUsage(token);
      return { ok: true, usage };
    } catch (err) {
      if (err instanceof UsageError) return { ok: false, error: err };
      // Duck-typed fallback: vitest's parallel transform can load usageClient.js twice, giving
      // a UsageError whose class identity differs from ours — rebuild it locally so the kind
      // (and the auth retry-once behavior) survives. Never fires in production (one module).
      if (err instanceof Error && err.name === 'UsageError' && typeof (err as UsageError).kind === 'string') {
        return { ok: false, error: new UsageError((err as UsageError).kind, err.message) };
      }
      return { ok: false, error: new UsageError('net', err instanceof Error ? err.message : String(err)) };
    }
  }

  async function pollUsage(): Promise<PollResult> {
    let result = await attemptFetch();
    if (!result.ok && result.error.kind === 'auth') {
      log.warn('limit watcher: auth error on usage poll, re-reading token and retrying once');
      result = await attemptFetch();
    }
    return result;
  }

  async function enterContinuing(now: number): Promise<void> {
    currentState = 'continuing';
    limitRepo.recordEvent(db, 'continuing', {}, now);
    persistAndEmit(now, null);

    // The ->limited snapshot only covers sessions active/just-stopped at detection time. Idle
    // sessions whose turn was killed by the limit (however long ago, including while the hub was
    // down) are found here by transcript evidence and joined onto the 'interrupted' track.
    // Fail-soft: a scan error never blocks continuation of the snapshot targets.
    try {
      const hits = await io.scanTranscripts({
        db,
        log,
        windowMs: config.autoContinue.transcriptScanWindowMinutes * 60_000,
        now,
      });
      if (hits.length > 0) {
        sessions.markInterrupted(db, hits, now);
        log.info(`limit watcher: transcript scan tagged ${hits.length} session(s) for continuation`);
      }
    } catch (err) {
      log.warn('limit watcher: transcript scan failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      const targets = sessions.interruptedSessions(db);
      await continuation.run(targets);
    } catch (err) {
      log.error('limit watcher: continuation.run threw', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Sweeps any sessions the continuation run skipped (ended / cap reached / disabled)
    // back to idle now that the limit has lifted; sessions it did continue already moved
    // off 'interrupted' status themselves.
    sessions.resetInterruptedToIdle(db);
    limitRepo.recordEvent(db, 'resumed', {}, now);
    currentState = 'ok';
  }

  async function tick(): Promise<void> {
    if (!config.limitWatcher.enabled || ticking) return;
    ticking = true;
    try {
      const now = io.now();

      if (lastTickAt !== 0) {
        const gap = now - lastTickAt;
        if (gap > FIVE_MIN_MS) {
          log.warn(`limit watcher: ${gap}ms gap since last tick — likely machine sleep/wake`, {
            gapMs: gap,
          });
        }
      }
      lastTickAt = now;

      const result = await pollUsage();
      let intervalMs: number;

      if (!result.ok) {
        log.warn(`limit watcher: usage poll failed (${result.error.kind}): ${result.error.message}`);
        currentState = 'unknown';
        persistAndEmit(now, result.error.message);
        intervalMs = result.error.kind === 'net' ? config.limitWatcher.retryIntervalMs : FIVE_MIN_MS;
      } else {
        const usage = result.usage;
        lastUtilization = usage.pct;
        lastResetsAt = usage.resetsAtMs;
        lastOkPollAt = now;
        const overThreshold = usage.pct >= config.limitWatcher.limitedThresholdPct;

        switch (currentState) {
          case 'ok':
          case 'unknown': {
            if (overThreshold) {
              sessions.markInterruptedCandidates(
                db,
                config.autoContinue.eligibleWindowMinutes * 60_000,
                now
              );
              limitRepo.recordEvent(db, 'limited', usage.raw, now);
              currentState = 'limited';
            } else if (currentState === 'unknown') {
              sessions.resetInterruptedToIdle(db);
              limitRepo.recordEvent(db, 'recovered', { pct: usage.pct }, now);
              currentState = 'ok';
            }
            break;
          }
          case 'limited': {
            if (!overThreshold) {
              sessions.resetInterruptedToIdle(db);
              limitRepo.recordEvent(db, 'recovered', { pct: usage.pct }, now);
              currentState = 'ok';
            } else if (lastResetsAt !== null) {
              limitRepo.recordEvent(db, 'waiting_reset', { resetsAtMs: lastResetsAt }, now);
              currentState = 'waiting_reset';
            }
            break;
          }
          case 'waiting_reset': {
            if (overThreshold) {
              // guard: fresh poll still over threshold — stay waiting regardless of reset time
            } else if (
              config.autoContinue.enabled &&
              lastResetsAt !== null &&
              now >= lastResetsAt + config.limitWatcher.resetJitterMs
            ) {
              await enterContinuing(now);
            } else {
              // pct already dropped (manual wait, or autoContinue disabled) — recover directly,
              // never entering 'continuing' when autoContinue is off.
              sessions.resetInterruptedToIdle(db);
              limitRepo.recordEvent(db, 'recovered', { pct: usage.pct }, now);
              currentState = 'ok';
            }
            break;
          }
          case 'continuing':
            // Unreachable in normal operation: tick() serializes via `ticking`, so enterContinuing
            // always resolves currentState back to 'ok' before another tick can observe it.
            break;
        }

        persistAndEmit(now, null);
        intervalMs = currentState === 'limited' ? FIVE_MIN_MS : config.limitWatcher.pollIntervalMs;
      }

      scheduleNext(intervalMs);
    } catch (err) {
      // tick() is always invoked fire-and-forget (`void tick()`), so any exception here would
      // otherwise become an unhandled rejection that crashes the whole always-on hub process.
      // Swallow, log, and keep the poll loop alive by scheduling the next attempt at the
      // slow backoff interval.
      log.error('limit watcher: tick() threw unexpectedly', {
        error: err instanceof Error ? err.message : String(err),
      });
      scheduleNext(FIVE_MIN_MS);
    } finally {
      ticking = false;
    }
  }

  function pokeNow(): void {
    if (ticking) return;
    clearTimer();
    void tick();
  }

  // Minimal per spec ("stop(): clearInterval"): cancels the scheduled timer chain only.
  // tick()/pokeNow() remain callable afterward (e.g. from tests driving _tick() directly);
  // stopped just stops scheduleNext() from re-arming a new timer at the end of a tick.
  function stop(): void {
    stopped = true;
    clearTimer();
  }

  function forceState(state: LimitStateName, resetsAtMs?: number | null): void {
    const now = io.now();
    if (resetsAtMs !== undefined) lastResetsAt = resetsAtMs;
    currentState = state;
    if (state === 'limited') {
      sessions.markInterruptedCandidates(db, config.autoContinue.eligibleWindowMinutes * 60_000, now);
    }
    persistAndEmit(now, null);
  }

  const watcher = {
    pokeNow,
    stop,
    forceState,
    _tick: tick,
  };

  scheduleNext(0);

  return watcher;
}
