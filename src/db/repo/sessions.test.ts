import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrations.js';
import * as instancesRepo from './instances.js';
import * as sessionsRepo from './sessions.js';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

describe('soleActiveNamedInstanceForCwd', () => {
  // Regression case for the bug where a dispatched task agent's MCP session, calling hub_register
  // with only cwd, resolved to the folder's cwd-derived default instance instead of its own named
  // task identity — see CLAUDE.md's Identity model / src/mcp/tools.ts's hub_register tier 3.
  it('exactly one active named session in the cwd -> resolves to that instance', () => {
    const db = buildDb();
    const now = Date.now();
    const named = instancesRepo.upsertNamed(db, { name: 'spawn-smoke2', cwd: 'F:\\rts\\proj', now });
    sessionsRepo.upsertFromHook(db, {
      sessionId: 'sess-1',
      cwd: 'F:\\rts\\proj',
      transcriptPath: null,
      instanceId: named.id,
      now,
    });

    const result = sessionsRepo.soleActiveNamedInstanceForCwd(db, 'F:\\rts\\proj');

    expect(result?.name).toBe('spawn-smoke2');
  });

  it('is case-insensitive on cwd (Windows path casing)', () => {
    const db = buildDb();
    const now = Date.now();
    const named = instancesRepo.upsertNamed(db, { name: 'spawn-smoke2', cwd: 'F:\\rts\\Proj', now });
    sessionsRepo.upsertFromHook(db, {
      sessionId: 'sess-1',
      cwd: 'F:\\rts\\Proj',
      transcriptPath: null,
      instanceId: named.id,
      now,
    });

    expect(sessionsRepo.soleActiveNamedInstanceForCwd(db, 'f:\\rts\\proj')?.name).toBe('spawn-smoke2');
  });

  it('TWO active named sessions sharing the cwd -> ambiguous, returns undefined', () => {
    const db = buildDb();
    const now = Date.now();
    const named1 = instancesRepo.upsertNamed(db, { name: 'task-a', cwd: 'F:\\rts\\proj', now });
    const named2 = instancesRepo.upsertNamed(db, { name: 'task-b', cwd: 'F:\\rts\\proj', now });
    sessionsRepo.upsertFromHook(db, {
      sessionId: 'sess-a',
      cwd: 'F:\\rts\\proj',
      transcriptPath: null,
      instanceId: named1.id,
      now,
    });
    sessionsRepo.upsertFromHook(db, {
      sessionId: 'sess-b',
      cwd: 'F:\\rts\\proj',
      transcriptPath: null,
      instanceId: named2.id,
      now,
    });

    expect(sessionsRepo.soleActiveNamedInstanceForCwd(db, 'F:\\rts\\proj')).toBeUndefined();
  });

  it('an ENDED named session only -> no active match, returns undefined', () => {
    const db = buildDb();
    const now = Date.now();
    const named = instancesRepo.upsertNamed(db, { name: 'spawn-smoke2', cwd: 'F:\\rts\\proj', now });
    sessionsRepo.upsertFromHook(db, {
      sessionId: 'sess-1',
      cwd: 'F:\\rts\\proj',
      transcriptPath: null,
      instanceId: named.id,
      now,
    });
    sessionsRepo.setStatus(db, 'sess-1', 'ended', now);

    expect(sessionsRepo.soleActiveNamedInstanceForCwd(db, 'F:\\rts\\proj')).toBeUndefined();
  });

  it('a session bound to the cwd-default (unnamed) instance does not count', () => {
    const db = buildDb();
    const now = Date.now();
    const unnamed = instancesRepo.upsert(db, { name: 'proj', cwd: 'F:\\rts\\proj', now });
    sessionsRepo.upsertFromHook(db, {
      sessionId: 'sess-1',
      cwd: 'F:\\rts\\proj',
      transcriptPath: null,
      instanceId: unnamed.id,
      now,
    });

    expect(sessionsRepo.soleActiveNamedInstanceForCwd(db, 'F:\\rts\\proj')).toBeUndefined();
  });

  it('no sessions at all in the cwd -> undefined', () => {
    const db = buildDb();
    expect(sessionsRepo.soleActiveNamedInstanceForCwd(db, 'F:\\rts\\nothing')).toBeUndefined();
  });

  it('two sessions for the SAME named instance (e.g. two terminals) still count as one distinct instance', () => {
    const db = buildDb();
    const now = Date.now();
    const named = instancesRepo.upsertNamed(db, { name: 'spawn-smoke2', cwd: 'F:\\rts\\proj', now });
    sessionsRepo.upsertFromHook(db, {
      sessionId: 'sess-1',
      cwd: 'F:\\rts\\proj',
      transcriptPath: null,
      instanceId: named.id,
      now,
    });
    sessionsRepo.upsertFromHook(db, {
      sessionId: 'sess-2',
      cwd: 'F:\\rts\\proj',
      transcriptPath: null,
      instanceId: named.id,
      now,
    });

    expect(sessionsRepo.soleActiveNamedInstanceForCwd(db, 'F:\\rts\\proj')?.name).toBe('spawn-smoke2');
  });
});

describe('listStale', () => {
  function seedSession(
    db: Database.Database,
    opts: { sessionId: string; cwd: string; ageMs: number; status?: 'active' | 'idle' | 'ended' | 'interrupted' | 'continuing' }
  ): void {
    const now = Date.now();
    const instance = instancesRepo.upsert(db, { name: opts.sessionId, cwd: opts.cwd, now: now - opts.ageMs });
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

  it('returns a non-ended session older than the threshold', () => {
    const db = buildDb();
    seedSession(db, { sessionId: 'sess-old', cwd: 'F:\\rts\\a', ageMs: 10 * 60_000, status: 'idle' });

    const stale = sessionsRepo.listStale(db, 5 * 60_000);

    expect(stale.map((s) => s.id)).toEqual(['sess-old']);
  });

  it('excludes a session younger than the threshold', () => {
    const db = buildDb();
    seedSession(db, { sessionId: 'sess-new', cwd: 'F:\\rts\\b', ageMs: 60_000, status: 'idle' });

    const stale = sessionsRepo.listStale(db, 5 * 60_000);

    expect(stale).toHaveLength(0);
  });

  it('excludes an already-ended session even if it is old', () => {
    const db = buildDb();
    seedSession(db, { sessionId: 'sess-ended', cwd: 'F:\\rts\\c', ageMs: 10 * 60_000, status: 'ended' });

    const stale = sessionsRepo.listStale(db, 5 * 60_000);

    expect(stale).toHaveLength(0);
  });

  it('includes non-idle non-ended statuses (e.g. interrupted) once stale', () => {
    const db = buildDb();
    seedSession(db, { sessionId: 'sess-interrupted', cwd: 'F:\\rts\\d', ageMs: 10 * 60_000, status: 'interrupted' });

    const stale = sessionsRepo.listStale(db, 5 * 60_000);

    expect(stale.map((s) => s.id)).toEqual(['sess-interrupted']);
  });

  it('joins instance_name for the reaper log/attach lookup', () => {
    const db = buildDb();
    const now = Date.now();
    const instance = instancesRepo.upsert(db, { name: 'joined-name', cwd: 'F:\\rts\\e', now: now - 10 * 60_000 });
    sessionsRepo.upsertFromHook(db, {
      sessionId: 'sess-joined',
      cwd: 'F:\\rts\\e',
      transcriptPath: null,
      instanceId: instance.id,
      now: now - 10 * 60_000,
    });
    sessionsRepo.setStatus(db, 'sess-joined', 'idle', now - 10 * 60_000);

    const stale = sessionsRepo.listStale(db, 5 * 60_000);

    expect(stale[0]?.instance_name).toBe('joined-name');
  });
});

describe('setSessionName', () => {
  it('stores the session name, defaulting to null beforehand', () => {
    const db = buildDb();
    const now = Date.now();
    const instance = instancesRepo.upsert(db, { name: 'proj', cwd: 'F:\\rts\\proj', now });
    sessionsRepo.upsertFromHook(db, { sessionId: 'sess-1', cwd: 'F:\\rts\\proj', transcriptPath: null, instanceId: instance.id, now });

    expect(sessionsRepo.get(db, 'sess-1')?.session_name).toBeNull();

    sessionsRepo.setSessionName(db, 'sess-1', 'wb-sync', now);

    expect(sessionsRepo.get(db, 'sess-1')?.session_name).toBe('wb-sync');
  });
});
