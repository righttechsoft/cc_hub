import type Database from 'better-sqlite3';
import type { PushTokenRow } from '../../types.js';

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

export function upsert(db: Database.Database, opts: { token: string; platform: string; now: number }): void {
  const { token, platform, now } = opts;
  stmt(
    db,
    `INSERT INTO push_tokens (token, platform, created_at, last_seen_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(token) DO UPDATE SET last_seen_at = excluded.last_seen_at, platform = excluded.platform`
  ).run(token, platform, now, now);
}

export function list(db: Database.Database): PushTokenRow[] {
  return stmt(db, 'SELECT * FROM push_tokens').all() as PushTokenRow[];
}

export function remove(db: Database.Database, token: string): void {
  stmt(db, 'DELETE FROM push_tokens WHERE token = ?').run(token);
}
