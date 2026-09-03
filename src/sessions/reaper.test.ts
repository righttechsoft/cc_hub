import { describe, expect, it, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrations.js';
import { startSessionReaper, type SessionReaper } from './reaper.js';
import * as instancesRepo from '../db/repo/instances.js';
import * as sessionsRepo from '../db/repo/sessions.js';
import type { HubConfig, IAttachRegistry, IClaudeRunner, Logger, SessionStatus } from '../types.js';

type TickableReaper = SessionReaper & { _tick(): Promise<void> };

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function buildConfig(overrides: Partial<HubConfig['sessions']> = {}): HubConfig {
  return {
    sessions: { reapIntervalMs: 600_000, staleAfterMinutes: 240, ...overrides },
  } as unknown as HubConfig;
}

function silentLogger(): Logger & { info: ReturnType<typeof vi.fn> } {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

// Only `get`/`getByName` matter to the reaper — the rest are unused stubs.
function fakeAttach(opts?: { attachedCwds?: string[] }): IAttachRegistry {
  const attachedCwds = new Set((opts?.attachedCwds ?? []).map((c) => c.toLowerCase()));
  return {
    register: vi.fn(),
    unregister: vi.fn(),
    get: (cwd: string) =>
      attachedCwds.has(cwd.toLowerCase()) ? ({} as ReturnType<IAttachRegistry['get']>) : undefined,
    inject: vi.fn(() => false),
    touch: vi.fn(),
    count: () => 0,
    ingestOutput: vi.fn(),
    getRingB64: () => undefined,
    listAttached: () => [...attachedCwds],
    setWorking: vi.fn(),
    isWorking: () => false,
    stop: vi.fn(),
  };
}

function fakeRunner(opts?: { runningSessionIds?: string[]; runningCwds?: string[] }): IClaudeRunner {
  const sessionIds = new Set(opts?.runningSessionIds ?? []);
  const cwds = new Set(opts?.runningCwds ?? []);
  return {
    resumePrompt: vi.fn(),
    startNew: vi.fn(),
    isRunning: (id: string) => sessionIds.has(id),
    runningCwd: (cwd: string) => cwds.has(cwd),
    atCapacity: () => false,
  };
}

function insertStaleSession(
  db: Database.Database,
  opts: { sessionId: string; cwd: string; instanceName: string; ageMs: number; status?: SessionStatus }
): void {
  const now = Date.now();
  const instance = instancesRepo.upsert(db, { name: opts.instanceName, cwd: opts.cwd, now: now - opts.ageMs });
  sessionsRepo.upsertFromHook(db, {
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    transcriptPath: null,
    instanceId: instance.id,
    now: now - opts.ageMs,
  });
  if (opts.status && opts.status !== 'active') {
    sessionsRepo.setStatus(db, opts.sessionId, opts.status, now - opts.ageMs);
  }
}

describe('startSessionReaper', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reaps a stale unattached session', async () => {
    const db = buildDb();
    insertStaleSession(db, {
      sessionId: 'sess-stale',
      cwd: 'F:\\rts\\proj-a',
      instanceName: 'proj-a',
      ageMs: 5 * 60 * 60 * 1000, // 5h old
      status: 'idle',
    });

    const log = silentLogger();
    const reaper = startSessionReaper({
      db,
      log,
      config: buildConfig({ staleAfterMinutes: 240 }),
      attach: fakeAttach(),
      runner: fakeRunner(),
    }) as TickableReaper;

    await reaper._tick();

    expect(sessionsRepo.get(db, 'sess-stale')?.status).toBe('ended');
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining('ended 1 stale sessions'),
      expect.objectContaining({ ids: ['sess-stale'] })
    );
    reaper.stop();
  });

  it('SPARES a stale session whose instance is attached', async () => {
    const db = buildDb();
    insertStaleSession(db, {
      sessionId: 'sess-attached',
      cwd: 'F:\\rts\\proj-b',
      instanceName: 'proj-b',
      ageMs: 5 * 60 * 60 * 1000,
      status: 'idle',
    });

    const log = silentLogger();
    const reaper = startSessionReaper({
      db,
      log,
      config: buildConfig({ staleAfterMinutes: 240 }),
      attach: fakeAttach({ attachedCwds: ['F:\\rts\\proj-b'] }),
      runner: fakeRunner(),
    }) as TickableReaper;

    await reaper._tick();

    expect(sessionsRepo.get(db, 'sess-attached')?.status).toBe('idle');
    expect(log.info).not.toHaveBeenCalled();
    reaper.stop();
  });

  it('spares a fresh session', async () => {
    const db = buildDb();
    insertStaleSession(db, {
      sessionId: 'sess-fresh',
      cwd: 'F:\\rts\\proj-c',
      instanceName: 'proj-c',
      ageMs: 5 * 60 * 1000, // 5 minutes old — well within the 240min threshold
      status: 'idle',
    });

    const log = silentLogger();
    const reaper = startSessionReaper({
      db,
      log,
      config: buildConfig({ staleAfterMinutes: 240 }),
      attach: fakeAttach(),
      runner: fakeRunner(),
    }) as TickableReaper;

    await reaper._tick();

    expect(sessionsRepo.get(db, 'sess-fresh')?.status).toBe('idle');
    expect(log.info).not.toHaveBeenCalled();
    reaper.stop();
  });

  it('spares a session the runner is busy with', async () => {
    const db = buildDb();
    insertStaleSession(db, {
      sessionId: 'sess-busy',
      cwd: 'F:\\rts\\proj-d',
      instanceName: 'proj-d',
      ageMs: 5 * 60 * 60 * 1000,
      status: 'idle',
    });

    const log = silentLogger();
    const reaper = startSessionReaper({
      db,
      log,
      config: buildConfig({ staleAfterMinutes: 240 }),
      attach: fakeAttach(),
      runner: fakeRunner({ runningSessionIds: ['sess-busy'] }),
    }) as TickableReaper;

    await reaper._tick();

    expect(sessionsRepo.get(db, 'sess-busy')?.status).toBe('idle');
    expect(log.info).not.toHaveBeenCalled();
    reaper.stop();
  });

  it('spares a session whose cwd the runner is busy with (runningCwd)', async () => {
    const db = buildDb();
    insertStaleSession(db, {
      sessionId: 'sess-busy-cwd',
      cwd: 'F:\\rts\\proj-e',
      instanceName: 'proj-e',
      ageMs: 5 * 60 * 60 * 1000,
      status: 'idle',
    });

    const log = silentLogger();
    const reaper = startSessionReaper({
      db,
      log,
      config: buildConfig({ staleAfterMinutes: 240 }),
      attach: fakeAttach(),
      runner: fakeRunner({ runningCwds: ['F:\\rts\\proj-e'] }),
    }) as TickableReaper;

    await reaper._tick();

    expect(sessionsRepo.get(db, 'sess-busy-cwd')?.status).toBe('idle');
    reaper.stop();
  });

  it('handles zero stale rows without logging noise', async () => {
    const db = buildDb();
    const log = silentLogger();
    const reaper = startSessionReaper({
      db,
      log,
      config: buildConfig(),
      attach: fakeAttach(),
      runner: fakeRunner(),
    }) as TickableReaper;

    await reaper._tick();

    expect(log.info).not.toHaveBeenCalled();
    reaper.stop();
  });

  it('stop() prevents further ticks', () => {
    vi.useFakeTimers();
    const db = buildDb();
    insertStaleSession(db, {
      sessionId: 'sess-timer',
      cwd: 'F:\\rts\\proj-f',
      instanceName: 'proj-f',
      ageMs: 5 * 60 * 60 * 1000,
      status: 'idle',
    });

    const log = silentLogger();
    const reaper = startSessionReaper({
      db,
      log,
      config: buildConfig({ reapIntervalMs: 10_000, staleAfterMinutes: 240 }),
      attach: fakeAttach(),
      runner: fakeRunner(),
    });

    reaper.stop();
    vi.advanceTimersByTime(60_000);

    // The scheduled tick never fired — the session is untouched.
    expect(sessionsRepo.get(db, 'sess-timer')?.status).toBe('idle');
  });
});
