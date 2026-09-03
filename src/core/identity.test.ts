import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrations.js';
import * as instancesRepo from '../db/repo/instances.js';
import { applyInstanceRename, instanceNameFromCwd, resolveExplicitInstanceName, INSTANCE_NAME_RE } from './identity.js';
import type { IAttachRegistry, RenameBindingSource } from '../types.js';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

describe('INSTANCE_NAME_RE', () => {
  it('accepts lowercase alnum/underscore/hyphen, 1-40 chars, starting alnum', () => {
    expect(INSTANCE_NAME_RE.test('wb-sync')).toBe(true);
    expect(INSTANCE_NAME_RE.test('a')).toBe(true);
    expect(INSTANCE_NAME_RE.test('cd_new2')).toBe(true);
  });

  it('rejects uppercase, leading punctuation, and empty', () => {
    expect(INSTANCE_NAME_RE.test('WbSync')).toBe(false);
    expect(INSTANCE_NAME_RE.test('-wb')).toBe(false);
    expect(INSTANCE_NAME_RE.test('')).toBe(false);
  });

  it('rejects names over 40 characters', () => {
    expect(INSTANCE_NAME_RE.test('a'.repeat(40))).toBe(true);
    expect(INSTANCE_NAME_RE.test('a'.repeat(41))).toBe(false);
  });
});

describe('instanceNameFromCwd', () => {
  it('uses the lowercased basename when free', () => {
    const db = buildDb();
    expect(instanceNameFromCwd(db, 'F:\\rts\\Wonkybox')).toBe('wonkybox');
  });

  it('is NOCASE-aware: a case-variant path reuses the same default identity, not a duplicate', () => {
    const db = buildDb();
    const now = Date.now();
    instancesRepo.upsert(db, { name: 'wonkybox', cwd: 'F:\\rts\\wonkybox', now });

    // A case-variant path for the SAME cwd must resolve to the SAME name, not a disambiguated one.
    expect(instanceNameFromCwd(db, 'F:\\rts\\Wonkybox')).toBe('wonkybox');
  });

  it('disambiguates with a parent-dir prefix, then a numeric suffix, when the basename is taken by a different cwd', () => {
    const db = buildDb();
    const now = Date.now();
    instancesRepo.upsert(db, { name: 'api', cwd: 'F:\\rts\\backend\\api', now });
    expect(instanceNameFromCwd(db, 'F:\\rts\\frontend\\api')).toBe('frontend-api');

    instancesRepo.upsert(db, { name: 'frontend-api', cwd: 'F:\\rts\\frontend\\api', now });
    expect(instanceNameFromCwd(db, 'F:\\other\\frontend\\api')).toBe('frontend-api-2');
  });

  it('does not let a named sibling at the SAME cwd silently steal the cwd-derived name', () => {
    const db = buildDb();
    const now = Date.now();
    // An explicitly-named sibling at this cwd happens to claim the name the default resolution
    // would otherwise pick for the folder itself.
    instancesRepo.upsertNamed(db, { name: 'wonkybox', cwd: 'F:\\rts\\wonkybox', now });

    // The default (named=0) resolution must NOT reuse/collide with that row — it needs a
    // different, disambiguated name since 'wonkybox' is already taken (globally-unique names).
    expect(instanceNameFromCwd(db, 'F:\\rts\\wonkybox')).not.toBe('wonkybox');
  });
});

describe('resolveExplicitInstanceName', () => {
  it('returns the requested name unclaimed, collided=false', () => {
    const db = buildDb();
    const result = resolveExplicitInstanceName(db, 'wb-sync', 'F:\\rts\\wonkybox');
    expect(result).toEqual({ name: 'wb-sync', collided: false });
  });

  it('reuses the existing row when the name is already claimed by THIS cwd (NOCASE)', () => {
    const db = buildDb();
    const now = Date.now();
    instancesRepo.upsertNamed(db, { name: 'wb-sync', cwd: 'F:\\rts\\Wonkybox', now });

    const result = resolveExplicitInstanceName(db, 'wb-sync', 'F:\\rts\\wonkybox');
    expect(result).toEqual({ name: 'wb-sync', collided: false });
  });

  it('disambiguates with a numeric suffix when the name is claimed by a DIFFERENT cwd, and flags collided', () => {
    const db = buildDb();
    const now = Date.now();
    instancesRepo.upsertNamed(db, { name: 'wb-sync', cwd: 'F:\\rts\\wonkybox', now });

    const result = resolveExplicitInstanceName(db, 'wb-sync', 'F:\\rts\\other-project');
    expect(result).toEqual({ name: 'wb-sync-2', collided: true });
  });

  it('keeps incrementing the suffix past an already-taken candidate', () => {
    const db = buildDb();
    const now = Date.now();
    instancesRepo.upsertNamed(db, { name: 'wb-sync', cwd: 'F:\\rts\\wonkybox', now });
    instancesRepo.upsertNamed(db, { name: 'wb-sync-2', cwd: 'F:\\rts\\another', now });

    const result = resolveExplicitInstanceName(db, 'wb-sync', 'F:\\rts\\yet-another');
    expect(result).toEqual({ name: 'wb-sync-3', collided: true });
  });
});

describe('instances repo: default vs named identities sharing a cwd', () => {
  it('upsert (default) and upsertNamed can coexist at the same cwd as separate rows', () => {
    const db = buildDb();
    const now = Date.now();
    const cwd = 'F:\\rts\\wonkybox';
    const def = instancesRepo.upsert(db, { name: 'wonkybox', cwd, now });
    const named = instancesRepo.upsertNamed(db, { name: 'wb-sync', cwd, now });

    expect(def.id).not.toBe(named.id);
    expect(instancesRepo.listByCwd(db, cwd).map((i) => i.name).sort()).toEqual(['wb-sync', 'wonkybox']);
  });

  it('byCwd only ever returns the default (named=0) row for a cwd', () => {
    const db = buildDb();
    const now = Date.now();
    const cwd = 'F:\\rts\\wonkybox';
    instancesRepo.upsert(db, { name: 'wonkybox', cwd, now });
    instancesRepo.upsertNamed(db, { name: 'wb-sync', cwd, now });

    expect(instancesRepo.byCwd(db, cwd)?.name).toBe('wonkybox');
  });

  it('rename updates the name in place, byName resolves it, and the id is stable', () => {
    const db = buildDb();
    const now = Date.now();
    const inst = instancesRepo.upsertNamed(db, { name: 'wb-sync', cwd: 'F:\\rts\\wonkybox', now });

    instancesRepo.rename(db, inst.id, 'wb-sync-2');

    expect(instancesRepo.byName(db, 'wb-sync')).toBeUndefined();
    expect(instancesRepo.byName(db, 'wb-sync-2')?.id).toBe(inst.id);
    expect(instancesRepo.byId(db, inst.id)?.name).toBe('wb-sync-2');
  });

  it('upsert (default, cwd-derived) sets name_source to cwd', () => {
    const db = buildDb();
    const inst = instancesRepo.upsert(db, { name: 'wonkybox', cwd: 'F:\\rts\\wonkybox', now: Date.now() });
    expect(inst.name_source).toBe('cwd');
    expect(instancesRepo.byId(db, inst.id)?.name_source).toBe('cwd');
  });

  it('upsertNamed (explicit) sets name_source to explicit', () => {
    const db = buildDb();
    const inst = instancesRepo.upsertNamed(db, { name: 'wb-sync', cwd: 'F:\\rts\\wonkybox', now: Date.now() });
    expect(inst.name_source).toBe('explicit');
    expect(instancesRepo.byId(db, inst.id)?.name_source).toBe('explicit');
  });

  it('rename defaults nameSource to explicit, and accepts an explicit nameSource override', () => {
    const db = buildDb();
    const now = Date.now();
    const inst = instancesRepo.upsert(db, { name: 'wonkybox', cwd: 'F:\\rts\\wonkybox', now });

    instancesRepo.rename(db, inst.id, 'wonkybox-2');
    expect(instancesRepo.byId(db, inst.id)?.name_source).toBe('explicit');

    instancesRepo.rename(db, inst.id, 'wonkybox-3', 'session');
    expect(instancesRepo.byId(db, inst.id)?.name_source).toBe('session');
  });

  it('markNamed flips named to 1 without touching the name', () => {
    const db = buildDb();
    const inst = instancesRepo.upsert(db, { name: 'wonkybox', cwd: 'F:\\rts\\wonkybox', now: Date.now() });
    expect(inst.named).toBe(0);

    instancesRepo.markNamed(db, inst.id);

    const after = instancesRepo.byId(db, inst.id);
    expect(after?.named).toBe(1);
    expect(after?.name).toBe('wonkybox');
  });
});

describe('applyInstanceRename', () => {
  function fakeAttach(): IAttachRegistry & { rename: ReturnType<typeof vi.fn> } {
    return {
      register: vi.fn(),
      unregister: vi.fn(),
      get: () => undefined,
      inject: vi.fn(() => false),
      touch: vi.fn(),
      count: () => 0,
      ingestOutput: vi.fn(),
      getRingB64: () => undefined,
      listAttached: () => [],
      setWorking: vi.fn(),
      isWorking: () => false,
      rename: vi.fn(),
      stop: vi.fn(),
    };
  }

  it('renames the durable row, re-keys the attach registry, and pushes the rename into the gateway binding', () => {
    const db = buildDb();
    const inst = instancesRepo.upsert(db, { name: 'proj', cwd: 'F:\\rts\\proj', now: Date.now() });
    const attach = fakeAttach();
    const gateway: RenameBindingSource & { renameBinding: ReturnType<typeof vi.fn> } = { renameBinding: vi.fn() };

    applyInstanceRename({ db, attach, gateway }, inst.id, 'proj', 'wb-sync', 'session');

    expect(instancesRepo.byId(db, inst.id)?.name).toBe('wb-sync');
    expect(instancesRepo.byId(db, inst.id)?.name_source).toBe('session');
    expect(attach.rename).toHaveBeenCalledWith('proj', 'wb-sync');
    expect(gateway.renameBinding).toHaveBeenCalledWith('proj', 'wb-sync');
  });

  it('works with no gateway (optional dep)', () => {
    const db = buildDb();
    const inst = instancesRepo.upsert(db, { name: 'proj', cwd: 'F:\\rts\\proj', now: Date.now() });
    const attach = fakeAttach();

    expect(() => applyInstanceRename({ db, attach }, inst.id, 'proj', 'wb-sync', 'explicit')).not.toThrow();
    expect(instancesRepo.byId(db, inst.id)?.name).toBe('wb-sync');
  });
});
