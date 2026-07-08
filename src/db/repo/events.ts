import type Database from 'better-sqlite3';
import type { SessionEventRow } from '../../types.js';

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

export function record(
  db: Database.Database,
  opts: { sessionId: string; instanceName: string | null; type: string; payload: unknown; now: number }
): SessionEventRow {
  const { sessionId, instanceName, type, payload, now } = opts;
  const json = JSON.stringify(payload);
  // JSON.stringify(undefined) returns undefined, not a string; store as NULL in that case.
  const serialized = typeof json === 'string' ? json.slice(0, 2048) : null;

  const result = stmt(
    db,
    'INSERT INTO session_events (session_id, instance_name, type, payload, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(sessionId, instanceName, type, serialized, now);

  return {
    id: Number(result.lastInsertRowid),
    session_id: sessionId,
    instance_name: instanceName,
    type,
    payload: serialized,
    created_at: now,
  };
}

export function listBySession(
  db: Database.Database,
  sessionId: string,
  afterId = 0,
  limit = 100
): SessionEventRow[] {
  return stmt(
    db,
    'SELECT * FROM session_events WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?'
  ).all(sessionId, afterId, limit) as SessionEventRow[];
}

export function recent(db: Database.Database, sessionId: string, limit = 20): SessionEventRow[] {
  return stmt(
    db,
    'SELECT * FROM session_events WHERE session_id = ? ORDER BY id DESC LIMIT ?'
  ).all(sessionId, limit) as SessionEventRow[];
}

export function purgeOlderThan(db: Database.Database, cutoffMs: number): number {
  const result = stmt(db, 'DELETE FROM session_events WHERE created_at < ?').run(cutoffMs);
  return result.changes;
}
