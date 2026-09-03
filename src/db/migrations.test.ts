import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations.js';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON'); // matches production's openDb() — FK enforcement ON before migrating
  return db;
}

describe('migration v7 (instances.cwd no longer UNIQUE, adds `named`)', () => {
  it('a fresh db migrates cleanly to the current version with the new column', () => {
    const db = buildDb();
    runMigrations(db);

    const cols = db.prepare('PRAGMA table_info(instances)').all() as { name: string; dflt_value: string | null }[];
    const named = cols.find((c) => c.name === 'named');
    expect(named).toBeDefined();
    expect(named?.dflt_value).toBe('0');

    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
    expect(Number(version.value)).toBeGreaterThanOrEqual(7);
  });

  it('two instances can now share one cwd (the UNIQUE constraint on cwd is gone)', () => {
    const db = buildDb();
    runMigrations(db);
    const now = Date.now();

    db.prepare('INSERT INTO instances (name, cwd, alias, first_seen_at, last_seen_at, named) VALUES (?, ?, NULL, ?, ?, 0)').run(
      'wonkybox',
      'F:\\rts\\wonkybox',
      now,
      now
    );

    expect(() =>
      db
        .prepare('INSERT INTO instances (name, cwd, alias, first_seen_at, last_seen_at, named) VALUES (?, ?, NULL, ?, ?, 1)')
        .run('wb-sync', 'F:\\rts\\wonkybox', now, now)
    ).not.toThrow();

    const rows = db.prepare('SELECT name FROM instances WHERE cwd = ?').all('F:\\rts\\wonkybox') as { name: string }[];
    expect(rows.map((r) => r.name).sort()).toEqual(['wb-sync', 'wonkybox']);
  });

  it('`name` stays globally UNIQUE after the rebuild', () => {
    const db = buildDb();
    runMigrations(db);
    const now = Date.now();
    db.prepare('INSERT INTO instances (name, cwd, alias, first_seen_at, last_seen_at, named) VALUES (?, ?, NULL, ?, ?, 0)').run(
      'wonkybox',
      'F:\\rts\\a',
      now,
      now
    );

    expect(() =>
      db
        .prepare('INSERT INTO instances (name, cwd, alias, first_seen_at, last_seen_at, named) VALUES (?, ?, NULL, ?, ?, 0)')
        .run('wonkybox', 'F:\\rts\\b', now, now)
    ).toThrow(/UNIQUE constraint failed/);
  });

  // The realistic case the table-rebuild migration must handle safely: an EXISTING, already
  // populated pre-v7 database (real sessions/instance_apps rows already pointing at instances.id
  // via FK) getting migration v7 applied on top, under foreign_keys=ON exactly as src/db/db.ts's
  // openDb() sets it before calling runMigrations. Hand-builds the pre-v7 schema (matching
  // migrations.ts v1/v5/v6) rather than going through runMigrations twice, since the migration
  // runner isn't parameterized by target version — the DROP TABLE this migration performs on a
  // table two others hold a FK reference to is exactly the risky part to prove out.
  it('preserves existing instances.id (and therefore sessions/instance_apps FK integrity) when migrating an already-populated pre-v7 db', () => {
    const db = buildDb();
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE instances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        cwd TEXT NOT NULL UNIQUE,
        alias TEXT,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        app_url TEXT,
        app_url_at INTEGER
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        instance_id INTEGER NOT NULL REFERENCES instances(id),
        cwd TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        started_at INTEGER NOT NULL,
        last_event_at INTEGER NOT NULL,
        auto_continue INTEGER NOT NULL DEFAULT 1,
        continues_today INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE instance_apps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id INTEGER NOT NULL REFERENCES instances(id),
        label TEXT NOT NULL,
        url TEXT,
        updated_at INTEGER NOT NULL,
        UNIQUE(instance_id, label)
      );
      INSERT INTO meta (key, value) VALUES ('schema_version', '6');
    `);
    const now = Date.now();
    const instResult = db
      .prepare('INSERT INTO instances (name, cwd, alias, first_seen_at, last_seen_at) VALUES (?, ?, NULL, ?, ?)')
      .run('wonkybox', 'F:\\rts\\wonkybox', now, now);
    const instanceId = Number(instResult.lastInsertRowid);
    db.prepare(
      `INSERT INTO sessions (id, instance_id, cwd, status, started_at, last_event_at, auto_continue, continues_today)
       VALUES (?, ?, ?, 'idle', ?, ?, 1, 0)`
    ).run('sess-1', instanceId, 'F:\\rts\\wonkybox', now, now);
    db.prepare('INSERT INTO instance_apps (instance_id, label, url, updated_at) VALUES (?, ?, ?, ?)').run(
      instanceId,
      'localhost:5173',
      'http://localhost:5173',
      now
    );

    // The migration under test (v7) runs here, on top of pre-existing, FK-referenced data.
    expect(() => runMigrations(db)).not.toThrow();

    // Same id, same row content — the rebuild must not have renumbered anything.
    expect(db.prepare('SELECT * FROM instances WHERE id = ?').get(instanceId)).toMatchObject({
      id: instanceId,
      name: 'wonkybox',
      cwd: 'F:\\rts\\wonkybox',
      named: 0,
    });

    // FK integrity: both pre-existing child rows still resolve back to the same instance row.
    const joined = db
      .prepare('SELECT instances.name FROM sessions JOIN instances ON instances.id = sessions.instance_id WHERE sessions.id = ?')
      .get('sess-1') as { name: string };
    expect(joined.name).toBe('wonkybox');

    const appJoined = db
      .prepare(
        'SELECT instances.name FROM instance_apps JOIN instances ON instances.id = instance_apps.instance_id WHERE instance_apps.label = ?'
      )
      .get('localhost:5173') as { name: string };
    expect(appJoined.name).toBe('wonkybox');

    // A fresh AUTOINCREMENT insert after the rebuild must not collide with the preserved id.
    const secondResult = db
      .prepare('INSERT INTO instances (name, cwd, alias, first_seen_at, last_seen_at, named) VALUES (?, ?, NULL, ?, ?, 0)')
      .run('other', 'F:\\rts\\other', now, now);
    expect(Number(secondResult.lastInsertRowid)).toBeGreaterThan(instanceId);
  });
});

describe('migration v8 (sessions.session_name, instances.name_source)', () => {
  it('a fresh db migrates cleanly with both new columns', () => {
    const db = buildDb();
    runMigrations(db);

    const sessionCols = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
    expect(sessionCols.some((c) => c.name === 'session_name')).toBe(true);

    const instanceCols = db.prepare('PRAGMA table_info(instances)').all() as { name: string; dflt_value: string | null }[];
    const nameSource = instanceCols.find((c) => c.name === 'name_source');
    expect(nameSource).toBeDefined();
    expect(nameSource?.dflt_value).toBe("'cwd'");

    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
    expect(Number(version.value)).toBeGreaterThanOrEqual(8);
  });

  it('gives existing pre-v8 instance rows the default name_source of cwd', () => {
    const db = buildDb();
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE instances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        cwd TEXT NOT NULL,
        alias TEXT,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        app_url TEXT,
        app_url_at INTEGER,
        named INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        instance_id INTEGER NOT NULL REFERENCES instances(id),
        cwd TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        started_at INTEGER NOT NULL,
        last_event_at INTEGER NOT NULL,
        auto_continue INTEGER NOT NULL DEFAULT 1,
        continues_today INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO meta (key, value) VALUES ('schema_version', '7');
    `);
    const now = Date.now();
    db.prepare('INSERT INTO instances (name, cwd, alias, first_seen_at, last_seen_at, named) VALUES (?, ?, NULL, ?, ?, 0)').run(
      'wonkybox',
      'F:\\rts\\wonkybox',
      now,
      now
    );

    expect(() => runMigrations(db)).not.toThrow();

    const row = db.prepare('SELECT name_source FROM instances WHERE name = ?').get('wonkybox') as { name_source: string };
    expect(row.name_source).toBe('cwd');
  });
});
