import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createDispatcher, decideDispatch, type DispatchCandidate } from './dispatcher.js';
import type { TerminalSpawner } from './terminalSpawner.js';
import { runMigrations } from '../db/migrations.js';
import * as instancesRepo from '../db/repo/instances.js';
import * as sessionsRepo from '../db/repo/sessions.js';
import * as eventsRepo from '../db/repo/events.js';
import type { HubConfig, IAttachRegistry, Logger } from '../types.js';

function silentLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function buildConfig(waitForRegisterMs = 60_000, confirmWorkingMs = 15_000): HubConfig {
  return {
    terminalSpawn: {
      enabled: true,
      command: 'wt.exe',
      args: [],
      maxPerHour: 6,
      waitForRegisterMs,
      readyQuietMs: 1200,
      confirmWorkingMs,
    },
  } as unknown as HubConfig;
}

// Real in-memory db + real repo functions (matches the convention in src/db/repo/sessions.test.ts)
// rather than a mocked db — the dispatcher's confirmation logic reads/writes through the actual
// eventsRepo/sessionsRepo queries, so a fake db object would just be reimplementing SQL in JS.
function buildDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function candidate(overrides: Partial<DispatchCandidate> = {}): DispatchCandidate {
  return { name: 'alpha', cwd: '/proj/alpha', attached: false, working: false, ...overrides };
}

describe('decideDispatch', () => {
  it('picks the first attached-and-idle candidate', () => {
    const candidates = [
      candidate({ name: 'a', cwd: '/a', attached: false }),
      candidate({ name: 'b', cwd: '/b', attached: true, working: false }),
      candidate({ name: 'c', cwd: '/c', attached: true, working: false }),
    ];
    expect(decideDispatch(candidates, 'fallback', '/fallback')).toEqual({ kind: 'inject', name: 'b', cwd: '/b' });
  });

  it('skips a working attached candidate in favor of spawning a fresh tab', () => {
    const candidates = [candidate({ name: 'a', cwd: '/a', attached: true, working: true })];
    expect(decideDispatch(candidates, 'fresh-task', '/fallback')).toEqual({
      kind: 'spawn',
      name: 'fresh-task',
      cwd: '/fallback',
    });
  });

  it('spawns when no candidate is attached', () => {
    const candidates = [candidate({ name: 'a', cwd: '/a', attached: false })];
    expect(decideDispatch(candidates, 'fresh-task', '/fallback')).toEqual({
      kind: 'spawn',
      name: 'fresh-task',
      cwd: '/fallback',
    });
  });

  it('spawns against the fallback cwd when there are no candidates at all', () => {
    expect(decideDispatch([], 'fresh-task', '/fallback')).toEqual({ kind: 'spawn', name: 'fresh-task', cwd: '/fallback' });
  });
});

function fakeAttach(overrides: Partial<IAttachRegistry> = {}): IAttachRegistry {
  return {
    register: vi.fn(),
    unregister: vi.fn(),
    get: vi.fn(() => undefined),
    inject: vi.fn(() => false),
    touch: vi.fn(),
    count: vi.fn(() => 0),
    ingestOutput: vi.fn(),
    getRingB64: vi.fn(() => undefined),
    listAttached: vi.fn(() => []),
    setWorking: vi.fn(),
    isWorking: vi.fn(() => false),
    stop: vi.fn(),
    ...overrides,
  } as unknown as IAttachRegistry;
}

function fakeSpawner(spawnResult: boolean): TerminalSpawner {
  return { spawn: vi.fn(() => spawnResult) };
}

// Records a session_event for `name` directly — simulates the hub's UserPromptSubmit hook
// recording activity for an instance, without needing a pre-existing session/instance row (see
// eventsRepo.record: instance_name is a denormalized column, no FK to sessions/instances).
function recordEventFor(db: Database.Database, name: string): void {
  eventsRepo.record(db, { sessionId: `sess-${name}`, instanceName: name, type: 'UserPromptSubmit', payload: null, now: Date.now() });
}

// Simulates a brand-new session appearing "from nothing" for `name` (SessionStart firing as a
// freshly spawned tab boots) — upsertFromHook defaults status to 'active'.
function spawnSessionFor(db: Database.Database, name: string, cwd: string): void {
  const now = Date.now();
  const inst = instancesRepo.upsertNamed(db, { name, cwd, now });
  sessionsRepo.upsertFromHook(db, { sessionId: `sess-${name}`, cwd, transcriptPath: null, instanceId: inst.id, now });
}

describe('createDispatcher', () => {
  it('inject action: injects via injectByName and reports "injected"', async () => {
    const db = buildDb();
    const log = silentLogger();
    const attach = fakeAttach({ injectByName: vi.fn(() => true), isWorkingByName: vi.fn(() => true) });
    const spawner = fakeSpawner(true);
    const dispatcher = createDispatcher({ attach, spawner, config: buildConfig(), db, log });

    const result = await dispatcher.dispatch({ kind: 'inject', name: 'wb-sync', cwd: '/proj/wb' }, 'do the task');

    expect(result).toEqual({ ok: true, via: 'injected' });
    expect(attach.injectByName).toHaveBeenCalledWith('wb-sync', 'do the task');
    expect(spawner.spawn).not.toHaveBeenCalled();
  });

  it('inject action: falls back to inject(cwd, ...) when injectByName is unavailable', async () => {
    const db = buildDb();
    const log = silentLogger();
    const attach = fakeAttach({ inject: vi.fn(() => true), isWorking: vi.fn(() => true) }); // no injectByName
    const dispatcher = createDispatcher({ attach, spawner: fakeSpawner(true), config: buildConfig(), db, log });

    const result = await dispatcher.dispatch({ kind: 'inject', name: 'wb-sync', cwd: '/proj/wb' }, 'task');

    expect(result).toEqual({ ok: true, via: 'injected' });
    expect(attach.inject).toHaveBeenCalledWith('/proj/wb', 'task');
  });

  it('inject action: reports "failed" when injection fails, without attempting to confirm', async () => {
    const db = buildDb();
    const log = silentLogger();
    const isWorkingByName = vi.fn(() => false);
    const attach = fakeAttach({ injectByName: vi.fn(() => false), isWorkingByName });
    const dispatcher = createDispatcher({ attach, spawner: fakeSpawner(true), config: buildConfig(), db, log });

    const result = await dispatcher.dispatch({ kind: 'inject', name: 'wb-sync', cwd: '/proj/wb' }, 'task');

    expect(result).toEqual({ ok: false, via: 'failed' });
    // Called once, to capture the pre-injection state — never entered the confirm/poll loop since
    // injection itself failed.
    expect(isWorkingByName).toHaveBeenCalledTimes(1);
  });

  it('inject action: already working BEFORE injecting -> success without waiting for a transition', async () => {
    const db = buildDb();
    const log = silentLogger();
    const injectByName = vi.fn(() => true);
    const isWorkingByName = vi.fn(() => true); // busy before AND after — no transition ever happens
    const attach = fakeAttach({ injectByName, isWorkingByName });
    const dispatcher = createDispatcher({ attach, spawner: fakeSpawner(true), config: buildConfig(), db, log });

    const result = await dispatcher.dispatch({ kind: 'inject', name: 'wb-sync', cwd: '/proj/wb' }, 'do the task');

    expect(result).toEqual({ ok: true, via: 'injected' });
    expect(injectByName).toHaveBeenCalledTimes(1); // never retried — already-working short-circuits the wait
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('inject action: a new session_event for the instance after inject confirms delivery, exactly one inject', async () => {
    vi.useFakeTimers();
    try {
      const db = buildDb();
      const log = silentLogger();
      const injectByName = vi.fn(() => true);
      const isWorkingByName = vi.fn(() => false); // never flips — confirmation must come from the DB signal
      const attach = fakeAttach({ injectByName, isWorkingByName });
      const dispatcher = createDispatcher({ attach, spawner: fakeSpawner(true), config: buildConfig(60_000, 15_000), db, log });

      const promise = dispatcher.dispatch({ kind: 'inject', name: 'wb-sync', cwd: '/proj/wb' }, 'do the task');

      // Nothing recorded yet — a couple of polls find no new activity.
      await vi.advanceTimersByTimeAsync(1_000);
      // The hub records a session_event once claude accepts the injected prompt (UserPromptSubmit).
      recordEventFor(db, 'wb-sync');
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await promise;

      expect(result).toEqual({ ok: true, via: 'injected' });
      expect(injectByName).toHaveBeenCalledTimes(1); // one initial injection, no retry needed
      expect(log.warn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('inject action: nothing ever happens -> retries once, still unconfirmed, but NEVER escalates beyond "injected"', async () => {
    vi.useFakeTimers();
    try {
      const db = buildDb();
      const log = silentLogger();
      const injectByName = vi.fn(() => true);
      const isWorkingByName = vi.fn(() => false); // never flips true
      const attach = fakeAttach({ injectByName, isWorkingByName });
      const dispatcher = createDispatcher({ attach, spawner: fakeSpawner(true), config: buildConfig(60_000, 2_000), db, log });

      const promise = dispatcher.dispatch({ kind: 'inject', name: 'wb-sync', cwd: '/proj/wb' }, 'do the task');
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await promise;

      expect(result).toEqual({ ok: true, via: 'injected' }); // visible terminal, human can see it — never escalated
      expect(injectByName).toHaveBeenCalledTimes(2); // initial + one retry
      expect(log.warn).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('spawn action: reports "failed" immediately when the spawner itself fails, without polling', async () => {
    const db = buildDb();
    const log = silentLogger();
    const attach = fakeAttach({ getByName: vi.fn() });
    const dispatcher = createDispatcher({ attach, spawner: fakeSpawner(false), config: buildConfig(), db, log });

    const result = await dispatcher.dispatch({ kind: 'spawn', name: 'wb-sync', cwd: '/proj/wb' }, 'task');

    expect(result).toEqual({ ok: false, via: 'failed' });
    expect(attach.getByName).not.toHaveBeenCalled();
  });

  it('spawn action: does not inject until the wrapper is BOTH registered and ready (registration alone is not enough)', async () => {
    vi.useFakeTimers();
    try {
      const db = buildDb();
      const log = silentLogger();
      // Registers immediately (as the real wrapper's WS does, ~1.5s into boot) but only reports
      // readiness after several polls — this is exactly the registration-vs-readiness gap the bug
      // was in.
      const getByName = vi.fn(() => ({ ws: {}, pid: 1, lastSeen: Date.now() }) as never);
      let readyChecks = 0;
      const isReadyByName = vi.fn(() => {
        readyChecks += 1;
        return readyChecks >= 4;
      });
      const injectByName = vi.fn(() => true);
      const isWorkingByName = vi.fn(() => true); // flips true immediately once the poll starts
      const attach = fakeAttach({ getByName, isReadyByName, injectByName, isWorkingByName });
      const dispatcher = createDispatcher({ attach, spawner: fakeSpawner(true), config: buildConfig(60_000, 15_000), db, log });

      const promise = dispatcher.dispatch({ kind: 'spawn', name: 'wb-sync', cwd: '/proj/wb' }, 'do the task');

      await vi.advanceTimersByTimeAsync(500);
      expect(injectByName).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(500);
      expect(injectByName).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5_000); // flush the remaining polls + the confirm wait
      const result = await promise;

      expect(injectByName).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ ok: true, via: 'spawned' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('spawn action: gives up after waitForRegisterMs if never ready, and reports "spawned_no_inject"', async () => {
    vi.useFakeTimers();
    try {
      const db = buildDb();
      const log = silentLogger();
      const getByName = vi.fn(() => undefined); // never registers
      const isReadyByName = vi.fn(() => false);
      const injectByName = vi.fn(() => true);
      const attach = fakeAttach({ getByName, isReadyByName, injectByName });
      const dispatcher = createDispatcher({ attach, spawner: fakeSpawner(true), config: buildConfig(3_000, 15_000), db, log });

      const promise = dispatcher.dispatch({ kind: 'spawn', name: 'wb-sync', cwd: '/proj/wb' }, 'task');
      await vi.advanceTimersByTimeAsync(3_000);
      const result = await promise;

      expect(result).toEqual({ ok: true, via: 'spawned_no_inject' });
      expect(injectByName).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('spawn action: already working before inject (e.g. a stale flag) -> success without waiting for a transition', async () => {
    const db = buildDb();
    const log = silentLogger();
    const getByName = vi.fn(() => ({ ws: {}, pid: 1, lastSeen: Date.now() }) as never);
    const isReadyByName = vi.fn(() => true);
    const injectByName = vi.fn(() => true);
    const isWorkingByName = vi.fn(() => true);
    const attach = fakeAttach({ getByName, isReadyByName, injectByName, isWorkingByName });
    const dispatcher = createDispatcher({ attach, spawner: fakeSpawner(true), config: buildConfig(60_000, 15_000), db, log });

    const result = await dispatcher.dispatch(
      { kind: 'spawn', name: 'wb-sync', cwd: '/proj/wb' },
      'implement the CSV export now'
    );

    expect(result).toEqual({ ok: true, via: 'spawned' });
    expect(injectByName).toHaveBeenCalledTimes(1);
  });

  it('spawn action: a session appearing from nothing (SessionStart as the fresh tab boots) confirms delivery, exactly one inject', async () => {
    vi.useFakeTimers();
    try {
      const db = buildDb();
      const log = silentLogger();
      const getByName = vi.fn(() => ({ ws: {}, pid: 1, lastSeen: Date.now() }) as never);
      const isReadyByName = vi.fn(() => true);
      const injectByName = vi.fn(() => true);
      const isWorkingByName = vi.fn(() => false); // never flips — confirmation must come from the DB signal
      const attach = fakeAttach({ getByName, isReadyByName, injectByName, isWorkingByName });
      const dispatcher = createDispatcher({ attach, spawner: fakeSpawner(true), config: buildConfig(60_000, 15_000), db, log });

      // No instance/session for 'wb-sync' exists yet at baseline time (a brand-new spawn's
      // instance isn't created until its SessionStart hook fires) — this is the special case that
      // must not break: baseline of "no sessions yet" -> ANY event for the instance counts.
      const promise = dispatcher.dispatch(
        { kind: 'spawn', name: 'wb-sync', cwd: '/proj/wb' },
        'implement the CSV export now'
      );

      await vi.advanceTimersByTimeAsync(1_000);
      spawnSessionFor(db, 'wb-sync', '/proj/wb'); // the session "appears from nothing"
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await promise;

      expect(result).toEqual({ ok: true, via: 'spawned' });
      expect(injectByName).toHaveBeenCalledTimes(1); // no retry needed
      expect(log.warn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('spawn action: the working flag flipping true also confirms delivery (kept as a secondary signal)', async () => {
    vi.useFakeTimers();
    try {
      const db = buildDb();
      const log = silentLogger();
      const getByName = vi.fn(() => ({ ws: {}, pid: 1, lastSeen: Date.now() }) as never);
      const isReadyByName = vi.fn(() => true);
      const injectByName = vi.fn(() => true);
      let checks = 0;
      const isWorkingByName = vi.fn(() => {
        checks += 1;
        // First call captures the PRE-injection state (false); flips true on the 4th poll call
        // after that.
        return checks > 4;
      });
      const attach = fakeAttach({ getByName, isReadyByName, injectByName, isWorkingByName });
      const dispatcher = createDispatcher({ attach, spawner: fakeSpawner(true), config: buildConfig(60_000, 15_000), db, log });

      const promise = dispatcher.dispatch(
        { kind: 'spawn', name: 'wb-sync', cwd: '/proj/wb' },
        'implement the CSV export now'
      );
      await vi.advanceTimersByTimeAsync(15_000);
      const result = await promise;

      expect(result).toEqual({ ok: true, via: 'spawned' });
      expect(injectByName).toHaveBeenCalledTimes(1); // no retry needed
      expect(log.warn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('spawn action: nothing ever happens -> two injects (initial + one retry), then "spawned_no_inject"', async () => {
    vi.useFakeTimers();
    try {
      const db = buildDb();
      const log = silentLogger();
      const getByName = vi.fn(() => ({ ws: {}, pid: 1, lastSeen: Date.now() }) as never);
      const isReadyByName = vi.fn(() => true);
      const injectByName = vi.fn(() => true);
      const isWorkingByName = vi.fn(() => false); // never flips true, no matter how many polls
      const attach = fakeAttach({ getByName, isReadyByName, injectByName, isWorkingByName });
      const dispatcher = createDispatcher({ attach, spawner: fakeSpawner(true), config: buildConfig(60_000, 2_000), db, log });

      const promise = dispatcher.dispatch(
        { kind: 'spawn', name: 'wb-sync', cwd: '/proj/wb' },
        'implement the CSV export now'
      );
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await promise;

      expect(result).toEqual({ ok: true, via: 'spawned_no_inject' });
      expect(injectByName).toHaveBeenCalledTimes(2); // initial + one retry, both unconfirmed
      expect(log.warn).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never throws — a thrown error from the registry surfaces as "failed"', async () => {
    const db = buildDb();
    const log = silentLogger();
    const attach = fakeAttach({
      injectByName: vi.fn(() => {
        throw new Error('boom');
      }),
    });
    const dispatcher = createDispatcher({ attach, spawner: fakeSpawner(true), config: buildConfig(), db, log });

    const result = await dispatcher.dispatch({ kind: 'inject', name: 'wb-sync', cwd: '/proj/wb' }, 'task');

    expect(result).toEqual({ ok: false, via: 'failed' });
  });
});
