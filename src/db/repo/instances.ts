import type Database from 'better-sqlite3';
import type { InstanceRow } from '../../types.js';

const cache = new WeakMap<Database.Database, Map<string, Database.Statement>>();
function stmt(db: Database.Database, sql: string): Database.Statement {
  let m = cache.get(db);
  if (!m) {
    m = new Map();
    cache.set(db, m);
  }
  let s = m.get(sql);
  if (!s) {
    s = db.prepare(sql);
    m.set(sql, s);
  }
  return s;
}

export function byCwd(db: Database.Database, cwd: string): InstanceRow | undefined {
  return stmt(db, 'SELECT * FROM instances WHERE cwd = ?').get(cwd) as InstanceRow | undefined;
}

export function byName(db: Database.Database, name: string): InstanceRow | undefined {
  return stmt(db, 'SELECT * FROM instances WHERE name = ?').get(name) as InstanceRow | undefined;
}

export function list(db: Database.Database): InstanceRow[] {
  return stmt(db, 'SELECT * FROM instances ORDER BY name ASC').all() as InstanceRow[];
}

export function setAlias(db: Database.Database, id: number, alias: string | null): void {
  stmt(db, 'UPDATE instances SET alias = ? WHERE id = ?').run(alias, id);
}

// cwd is the identity key (UNIQUE); name collisions are pre-resolved by the caller
// (core/identity.ts) before this is called.
export function upsert(
  db: Database.Database,
  opts: { name: string; cwd: string; now: number }
): InstanceRow {
  const { name, cwd, now } = opts;
  const existing = byCwd(db, cwd);
  if (existing) {
    stmt(db, 'UPDATE instances SET last_seen_at = ? WHERE id = ?').run(now, existing.id);
    return { ...existing, last_seen_at: now };
  }

  const result = stmt(
    db,
    'INSERT INTO instances (name, cwd, alias, first_seen_at, last_seen_at) VALUES (?, ?, NULL, ?, ?)'
  ).run(name, cwd, now, now);

  return {
    id: Number(result.lastInsertRowid),
    name,
    cwd,
    alias: null,
    first_seen_at: now,
    last_seen_at: now,
  };
}
