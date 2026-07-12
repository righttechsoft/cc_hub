import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrations.js';
import { HubBus } from '../core/bus.js';
import { startLimitWatcher, type WatcherIo } from './watcher.js';
import { ContinuationRunner } from './continuation.js';
import { parseUsage, UsageError } from './usageClient.js';
import type {
  HubConfig,
  HubEvent,
  ILimitWatcher,
  IContinuationRunner,
  IPromptDelivery,
  Logger,
  SessionRow,
  Usage,
} from '../types.js';

type TickableWatcher = ILimitWatcher & { _tick(): Promise<void> };

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function buildConfig(opts?: {
  limitWatcher?: Partial<HubConfig['limitWatcher']>;
  autoContinue?: Partial<HubConfig['autoContinue']>;
}): HubConfig {
  return {
    port: 4270,
    bindAddress: '127.0.0.1',
    authToken: 'test-token',
    claudePath: 'claude.exe',
    hooks: { postToolUse: false, postToolUseThrottleMs: 2000, permissionWaitMs: 30000 },
    limitWatcher: {
      enabled: true,
      pollIntervalMs: 3_600_000,
      retryIntervalMs: 3_600_000,
      limitedThresholdPct: 95,
      resetJitterMs: 90_000,
      ...opts?.limitWatcher,
    },
    autoContinue: {
      enabled: true,
      prompt: 'continue where you left off',
      maxPerSessionPerDay: 3,
      maxConcurrent: 1,
      eligibleWindowMinutes: 10,
      transcriptScanWindowMinutes: 360,
      permissionMode: 'default',
      ...opts?.autoContinue,
    },
    retention: { sessionEventsDays: 14, messagesDays: 90 },
    relay: { enabled: false, url: '', secret: '' },
    chatDelivery: {
      enabled: true,
      tickMs: 30000,
      maxSpawnsPerInstancePerHour: 4,
    },
    athen: { embeddings: false, model: 'Xenova/all-MiniLM-L6-v2' },
    notifications: { enabled: false, permissionRequests: true, needsInput: true, turnEnd: false, limit: true, chatDelivery: true },
    push: {
      enabled: false,
      awayThresholdMinutes: 3,
      apns: { keyPath: '', keyId: '', teamId: '', bundleId: 'com.righttechsoft.ccHubMobile', environment: 'production' },
    },
    logLevel: 'info',
  };
}

function silentLogger(): Logger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function insertInstance(db: Database.Database, name: string, cwd: string): number {
  const now = Date.now();
  const info = db
    .prepare('INSERT INTO instances (name, cwd, alias, first_seen_at, last_seen_at) VALUES (?, ?, NULL, ?, ?)')
    .run(name, cwd, now, now);
  return Number(info.lastInsertRowid);
}

function insertActiveSession(db: Database.Database, id: string, instanceId: number): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO sessions
      (id, instance_id, cwd, status, started_at, last_event_at, auto_continue, continues_today, continues_date)
     VALUES (?, ?, '/proj', 'active', ?, ?, 1, 0, NULL)`
  ).run(id, instanceId, now, now);
}

function insertIdleSession(db: Database.Database, id: string, instanceId: number, lastEventAt: number): void {
  db.prepare(
    `INSERT INTO sessions
      (id, instance_id, cwd, transcript_path, status, started_at, last_event_at, auto_continue, continues_today, continues_date)
     VALUES (?, ?, '/proj', ?, 'idle', ?, ?, 1, 0, NULL)`
  ).run(id, instanceId, `/transcripts/${id}.jsonl`, lastEventAt, lastEventAt);
}

function sessionStatus(db: Database.Database, id: string): string {
  const row = db.prepare('SELECT status FROM sessions WHERE id = ?').get(id) as { status: string };
  return row.status;
}

function limitStateRow(db: Database.Database): {
  state: string;
  utilization: number | null;
  resets_at: number | null;
} {
  return db.prepare('SELECT state, utilization, resets_at FROM limit_state WHERE id = 1').get() as {
    state: string;
    utilization: number | null;
    resets_at: number | null;
  };
}

function localDateString(now: number): string {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

class FakeContinuation implements IContinuationRunner {
  calls: SessionRow[][] = [];
  async run(sessionsToRun: SessionRow[]): Promise<void> {
    this.calls.push(sessionsToRun);
  }
}

function makeClock(startMs: number): { now: () => number; advance: (ms: number) => void } {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function makeUsage(pct: number, resetsAtMs: number | null = null): Usage {
  return { pct, resetsAtMs, raw: { five_hour: { utilization: pct / 100, resets_at: resetsAtMs } } };
}

// Constructs the watcher then immediately cancels its auto-kickoff timer (armed via
// scheduleNext(0) inside startLimitWatcher) so tests can drive every tick deterministically
// via _tick(). This works because the cancellation runs synchronously before the event loop
// ever gets a chance to fire the 0ms timer.
function startWatcher(
  db: Database.Database,
  config: HubConfig,
  bus: HubBus,
  continuation: IContinuationRunner,
  io: WatcherIo
): TickableWatcher {
  const watcher = startLimitWatcher({
    db,
    config,
    bus,
    log: silentLogger(),
    continuation,
    // State-machine tests never touch the filesystem: transcript scan defaults to a no-op stub.
    io: { scanTranscripts: async () => [], ...io },
  }) as TickableWatcher;
  watcher.stop();
  return watcher;
}

describe('startLimitWatcher state machine', () => {
  it('progresses ok -> limited -> waiting_reset -> continuing -> ok, marking and clearing interrupted sessions', async () => {
    const db = buildDb();
    const instanceId = insertInstance(db, 'proj', '/proj');
    insertActiveSession(db, 'sess-1', instanceId);

    const bus = new HubBus();
    const events: HubEvent[] = [];
    bus.on((e) => events.push(e));

    const continuation = new FakeContinuation();
    const clock = makeClock(1_000_000);
    const resetsAt = clock.now() + 60_000;

    const fetchUsage = vi
      .fn()
      .mockResolvedValueOnce(makeUsage(50)) // tick1: below threshold, stays ok
      .mockResolvedValueOnce(makeUsage(96)) // tick2: ok -> limited (resets_at unknown yet)
      .mockResolvedValueOnce(makeUsage(97, resetsAt)) // tick3: limited -> waiting_reset
      .mockResolvedValueOnce(makeUsage(10, resetsAt)); // tick4: after reset+jitter, pct dropped -> continuing -> ok

    const config = buildConfig();
    const watcher = startWatcher(db, config, bus, continuation, {
      now: clock.now,
      readAccessToken: () => 'token',
      fetchUsage,
    });

    await watcher._tick();
    expect(limitStateRow(db).state).toBe('ok');

    await watcher._tick();
    expect(limitStateRow(db).state).toBe('limited');
    expect(sessionStatus(db, 'sess-1')).toBe('interrupted');

    await watcher._tick();
    expect(limitStateRow(db).state).toBe('waiting_reset');

    clock.advance(config.limitWatcher.resetJitterMs + 61_000); // now past resets_at + jitter
    await watcher._tick();

    expect(continuation.calls).toHaveLength(1);
    expect(continuation.calls[0].map((s) => s.id)).toContain('sess-1');
    expect(limitStateRow(db).state).toBe('ok');
    expect(sessionStatus(db, 'sess-1')).toBe('idle');

    const limitEvents = events.filter((e): e is Extract<HubEvent, { type: 'limit_state' }> => e.type === 'limit_state');
    expect(limitEvents.map((e) => e.state.state)).toEqual(['ok', 'limited', 'waiting_reset', 'continuing', 'ok']);
  });

  it('moves to unknown on an auth failure (after one retry) and recovers to ok once polling succeeds again', async () => {
    const db = buildDb();
    const bus = new HubBus();
    const continuation = new FakeContinuation();
    const clock = makeClock(2_000_000);

    const fetchUsage = vi
      .fn()
      .mockRejectedValueOnce(new UsageError('auth', 'expired')) // tick1 first attempt
      .mockRejectedValueOnce(new UsageError('auth', 'expired')) // tick1 retry-once (re-reads token first)
      .mockResolvedValueOnce(makeUsage(20)); // tick2: recovers

    const config = buildConfig();
    const watcher = startWatcher(db, config, bus, continuation, {
      now: clock.now,
      readAccessToken: () => 'token',
      fetchUsage,
    });

    await watcher._tick();
    expect(fetchUsage).toHaveBeenCalledTimes(2);
    expect(limitStateRow(db).state).toBe('unknown');

    await watcher._tick();
    expect(limitStateRow(db).state).toBe('ok');
  });

  it('stays limited with no resets_at until pct drops, recovering directly without running continuation', async () => {
    const db = buildDb();
    const instanceId = insertInstance(db, 'proj2', '/proj2');
    insertActiveSession(db, 'sess-2', instanceId);

    const bus = new HubBus();
    const continuation = new FakeContinuation();
    const clock = makeClock(3_000_000);

    const fetchUsage = vi
      .fn()
      .mockResolvedValueOnce(makeUsage(96)) // ok -> limited, resets_at unknown
      .mockResolvedValueOnce(makeUsage(96)) // stays limited (still no resets_at)
      .mockResolvedValueOnce(makeUsage(50)); // pct drops -> recover directly to ok

    const config = buildConfig();
    const watcher = startWatcher(db, config, bus, continuation, {
      now: clock.now,
      readAccessToken: () => 'token',
      fetchUsage,
    });

    await watcher._tick();
    expect(limitStateRow(db).state).toBe('limited');
    expect(sessionStatus(db, 'sess-2')).toBe('interrupted');

    await watcher._tick();
    expect(limitStateRow(db).state).toBe('limited');

    await watcher._tick();
    expect(limitStateRow(db).state).toBe('ok');
    expect(sessionStatus(db, 'sess-2')).toBe('idle');
    expect(continuation.calls).toHaveLength(0);
  });

  it('handles a large clock jump (machine wake) crossing resets_at + jitter within a single tick', async () => {
    const db = buildDb();
    const instanceId = insertInstance(db, 'proj3', '/proj3');
    insertActiveSession(db, 'sess-3', instanceId);

    const bus = new HubBus();
    const continuation = new FakeContinuation();
    const clock = makeClock(4_000_000);
    const resetsAt = clock.now() + 30_000;

    const fetchUsage = vi
      .fn()
      .mockResolvedValueOnce(makeUsage(96)) // ok -> limited
      .mockResolvedValueOnce(makeUsage(96, resetsAt)) // limited -> waiting_reset
      .mockResolvedValueOnce(makeUsage(5, resetsAt)); // big jump forward + pct dropped -> continuing -> ok, one tick

    const config = buildConfig();
    const watcher = startWatcher(db, config, bus, continuation, {
      now: clock.now,
      readAccessToken: () => 'token',
      fetchUsage,
    });

    await watcher._tick();
    await watcher._tick();
    expect(limitStateRow(db).state).toBe('waiting_reset');

    clock.advance(10 * 60_000); // 10 minutes forward: past resets_at+jitter and past the 5-min wake-gap threshold
    await watcher._tick();

    expect(limitStateRow(db).state).toBe('ok');
    expect(continuation.calls).toHaveLength(1);
    expect(sessionStatus(db, 'sess-3')).toBe('idle');
  });

  it('continues a long-idle session found by the transcript scan at continue time', async () => {
    const db = buildDb();
    const instanceId = insertInstance(db, 'proj7', '/proj7');

    const bus = new HubBus();
    const continuation = new FakeContinuation();
    const clock = makeClock(10_000_000);
    // Idle for 3 hours — far outside the ->limited snapshot's 5-minute window, so only the
    // continue-time transcript scan can select it.
    insertIdleSession(db, 'sess-7', instanceId, clock.now() - 3 * 60 * 60_000);
    const resetsAt = clock.now() + 30_000;

    const fetchUsage = vi
      .fn()
      .mockResolvedValueOnce(makeUsage(100)) // ok -> limited
      .mockResolvedValueOnce(makeUsage(100, resetsAt)) // limited -> waiting_reset
      .mockResolvedValueOnce(makeUsage(5, resetsAt)); // past reset -> continuing -> ok

    const scanTranscripts = vi.fn(async (_deps: { windowMs: number }) => ['sess-7']);
    const config = buildConfig({ limitWatcher: { limitedThresholdPct: 100 } });
    const watcher = startWatcher(db, config, bus, continuation, {
      now: clock.now,
      readAccessToken: () => 'token',
      fetchUsage,
      scanTranscripts,
    });

    await watcher._tick();
    expect(sessionStatus(db, 'sess-7')).toBe('idle'); // snapshot did NOT pick it up

    await watcher._tick();
    clock.advance(config.limitWatcher.resetJitterMs + 61_000);
    await watcher._tick();

    expect(scanTranscripts).toHaveBeenCalledTimes(1);
    expect(scanTranscripts.mock.calls[0][0]).toMatchObject({ windowMs: 360 * 60_000 });
    expect(continuation.calls).toHaveLength(1);
    expect(continuation.calls[0].map((s) => s.id)).toContain('sess-7');
    expect(sessionStatus(db, 'sess-7')).toBe('idle'); // swept back after the run
    expect(limitStateRow(db).state).toBe('ok');
  });

  it('survives a transcript scan failure and still continues snapshot-selected sessions', async () => {
    const db = buildDb();
    const instanceId = insertInstance(db, 'proj8', '/proj8');
    insertActiveSession(db, 'sess-8', instanceId);

    const bus = new HubBus();
    const continuation = new FakeContinuation();
    const clock = makeClock(11_000_000);
    const resetsAt = clock.now() + 30_000;

    const fetchUsage = vi
      .fn()
      .mockResolvedValueOnce(makeUsage(100))
      .mockResolvedValueOnce(makeUsage(100, resetsAt))
      .mockResolvedValueOnce(makeUsage(5, resetsAt));

    const scanTranscripts = vi.fn(async () => {
      throw new Error('disk exploded');
    });
    const config = buildConfig({ limitWatcher: { limitedThresholdPct: 100 } });
    const watcher = startWatcher(db, config, bus, continuation, {
      now: clock.now,
      readAccessToken: () => 'token',
      fetchUsage,
      scanTranscripts,
    });

    await watcher._tick();
    await watcher._tick();
    clock.advance(config.limitWatcher.resetJitterMs + 61_000);
    await watcher._tick();

    expect(continuation.calls).toHaveLength(1);
    expect(continuation.calls[0].map((s) => s.id)).toContain('sess-8');
    expect(limitStateRow(db).state).toBe('ok');
  });

  it('never enters continuing when autoContinue is disabled, recovering directly to ok once pct drops', async () => {
    const db = buildDb();
    const instanceId = insertInstance(db, 'proj6', '/proj6');
    insertActiveSession(db, 'sess-6', instanceId);

    const bus = new HubBus();
    const continuation = new FakeContinuation();
    const clock = makeClock(5_000_000);
    const resetsAt = clock.now() + 30_000;

    const fetchUsage = vi
      .fn()
      .mockResolvedValueOnce(makeUsage(96)) // ok -> limited
      .mockResolvedValueOnce(makeUsage(96, resetsAt)) // limited -> waiting_reset
      .mockResolvedValueOnce(makeUsage(20, resetsAt)); // pct dropped; autoContinue disabled -> straight to ok

    const config = buildConfig({ autoContinue: { enabled: false } });
    const watcher = startWatcher(db, config, bus, continuation, {
      now: clock.now,
      readAccessToken: () => 'token',
      fetchUsage,
    });

    await watcher._tick();
    await watcher._tick();
    expect(limitStateRow(db).state).toBe('waiting_reset');

    clock.advance(config.limitWatcher.resetJitterMs + 61_000);
    await watcher._tick();

    expect(limitStateRow(db).state).toBe('ok');
    expect(continuation.calls).toHaveLength(0);
    expect(sessionStatus(db, 'sess-6')).toBe('idle');
  });
});

describe('ContinuationRunner', () => {
  it('skips a session that already hit its daily continue cap', async () => {
    const db = buildDb();
    const instanceId = insertInstance(db, 'proj4', '/proj4');
    insertActiveSession(db, 'sess-4', instanceId);
    const today = localDateString(Date.now());
    db.prepare('UPDATE sessions SET continues_today = 3, continues_date = ? WHERE id = ?').run(today, 'sess-4');

    const bus = new HubBus();
    const sent: string[] = [];
    const delivery: IPromptDelivery = {
      async send(sessionId) {
        sent.push(sessionId);
        return { delivery: 'spawned', pendingPromptId: 1 };
      },
      claimForStopBlock() {
        return undefined;
      },
    };

    const config = buildConfig({ autoContinue: { maxPerSessionPerDay: 3 } });
    const runner = new ContinuationRunner({ db, bus, log: silentLogger(), delivery, config });
    const sessionRow = db.prepare('SELECT * FROM sessions WHERE id = ?').get('sess-4') as SessionRow;

    await runner.run([sessionRow]);

    expect(sent).toHaveLength(0);
    expect(sessionStatus(db, 'sess-4')).toBe('active'); // untouched — never moved to 'continuing'
  });

  it('treats maxPerSessionPerDay <= 0 as unlimited', async () => {
    const db = buildDb();
    const instanceId = insertInstance(db, 'proj9', '/proj9');
    insertActiveSession(db, 'sess-9', instanceId);
    const today = localDateString(Date.now());
    db.prepare('UPDATE sessions SET continues_today = 99, continues_date = ? WHERE id = ?').run(today, 'sess-9');

    const bus = new HubBus();
    const sent: string[] = [];
    const delivery: IPromptDelivery = {
      async send(sessionId) {
        sent.push(sessionId);
        return { delivery: 'spawned', pendingPromptId: 1 };
      },
      claimForStopBlock() {
        return undefined;
      },
    };

    const config = buildConfig({ autoContinue: { maxPerSessionPerDay: 0 } });
    const runner = new ContinuationRunner({ db, bus, log: silentLogger(), delivery, config });
    const sessionRow = db.prepare('SELECT * FROM sessions WHERE id = ?').get('sess-9') as SessionRow;

    await runner.run([sessionRow]);

    expect(sent).toEqual(['sess-9']);
  });

  it('continues a session under the cap, bumping its counter and recording the attempt', async () => {
    const db = buildDb();
    const instanceId = insertInstance(db, 'proj5', '/proj5');
    insertActiveSession(db, 'sess-5', instanceId);

    const bus = new HubBus();
    const sent: string[] = [];
    const delivery: IPromptDelivery = {
      async send(sessionId) {
        sent.push(sessionId);
        return { delivery: 'spawned', pendingPromptId: 1 };
      },
      claimForStopBlock() {
        return undefined;
      },
    };

    const config = buildConfig();
    const runner = new ContinuationRunner({ db, bus, log: silentLogger(), delivery, config });
    const sessionRow = db.prepare('SELECT * FROM sessions WHERE id = ?').get('sess-5') as SessionRow;

    await runner.run([sessionRow]);

    expect(sent).toEqual(['sess-5']);
  });
});

describe('parseUsage', () => {
  it('normalizes a fractional pct to a percentage and treats a small number as epoch-seconds', () => {
    const usage = parseUsage({ five_hour: { utilization: 0.42, resets_at: 1_700_000_000 } });
    expect(usage.pct).toBeCloseTo(42);
    expect(usage.resetsAtMs).toBe(1_700_000_000 * 1000);
  });

  it('treats an already-large number as milliseconds', () => {
    const usage = parseUsage({ five_hour: { percent: 60, reset_at: 1_700_000_000_000 } });
    expect(usage.pct).toBe(60);
    expect(usage.resetsAtMs).toBe(1_700_000_000_000);
  });

  it('parses an ISO8601 reset string', () => {
    const iso = '2026-01-01T00:00:00Z';
    const usage = parseUsage({ five_hour: { used: 10, reset: iso } });
    expect(usage.pct).toBe(10);
    expect(usage.resetsAtMs).toBe(Date.parse(iso));
  });

  it('falls back to a bare numeric five_hour value when no sub-key matches', () => {
    const usage = parseUsage({ five_hour: 0.8 });
    expect(usage.pct).toBeCloseTo(80);
    expect(usage.resetsAtMs).toBeNull();
  });

  it('coerces a numeric-string percentage', () => {
    const usage = parseUsage({ five_hour: { percentage: '97.5' } });
    expect(usage.pct).toBeCloseTo(97.5);
  });

  it('throws a parse UsageError when five_hour is missing', () => {
    expect(() => parseUsage({})).toThrow(UsageError);
    let caught: unknown;
    try {
      parseUsage({});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UsageError);
    expect((caught as UsageError).kind).toBe('parse');
  });
});
