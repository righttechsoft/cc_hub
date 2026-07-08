import type Database from 'better-sqlite3';
import type { LimitStateRow, LimitEventRow } from '../../types.js';

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

export function getState(db: Database.Database): LimitStateRow {
  return stmt(db, 'SELECT * FROM limit_state WHERE id = 1').get() as LimitStateRow;
}

export function patchState(
  db: Database.Database,
  partial: Partial<Omit<LimitStateRow, 'id'>>
): LimitStateRow {
  const entries = Object.entries(partial) as [
    keyof Omit<LimitStateRow, 'id'>,
    LimitStateRow[keyof Omit<LimitStateRow, 'id'>],
  ][];

  if (entries.length > 0) {
    const setClause = entries.map(([key]) => `${String(key)} = ?`).join(', ');
    const values = entries.map(([, value]) => value);
    stmt(db, `UPDATE limit_state SET ${setClause} WHERE id = 1`).run(...values);
  }

  return getState(db);
}

export function recordEvent(db: Database.Database, type: string, detail: unknown, now: number = Date.now()): void {
  const json = JSON.stringify(detail);
  stmt(db, 'INSERT INTO limit_events (type, detail, created_at) VALUES (?, ?, ?)').run(
    type,
    typeof json === 'string' ? json : null,
    now
  );
}

export function listEvents(db: Database.Database, limit = 20): LimitEventRow[] {
  return stmt(db, 'SELECT * FROM limit_events ORDER BY id DESC LIMIT ?').all(limit) as LimitEventRow[];
}
