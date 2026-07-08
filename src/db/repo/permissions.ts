import type Database from 'better-sqlite3';
import type { PermissionRow, PermissionStatus } from '../../types.js';

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

export function insert(
  db: Database.Database,
  opts: { sessionId: string; toolName: string; toolInput: string | null; raw: string | null; now: number }
): PermissionRow {
  const { sessionId, toolName, toolInput, raw, now } = opts;
  const result = stmt(
    db,
    `INSERT INTO permission_requests (session_id, tool_name, tool_input, raw, status, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`
  ).run(sessionId, toolName, toolInput, raw, now);

  return {
    id: Number(result.lastInsertRowid),
    session_id: sessionId,
    tool_name: toolName,
    tool_input: toolInput,
    raw,
    status: 'pending',
    decided_by: null,
    decision_message: null,
    created_at: now,
    decided_at: null,
  };
}

export function get(db: Database.Database, id: number): PermissionRow | undefined {
  return stmt(db, 'SELECT * FROM permission_requests WHERE id = ?').get(id) as
    | PermissionRow
    | undefined;
}

// Only transitions a still-pending row; returns undefined when another decider (or a timeout)
// already resolved it, so the caller (long-poll or mobile REST) can report the conflict.
export function decide(
  db: Database.Database,
  id: number,
  opts: { status: 'allowed' | 'denied'; decidedBy: string; message: string | null; now: number }
): PermissionRow | undefined {
  const { status, decidedBy, message, now } = opts;
  const result = stmt(
    db,
    `UPDATE permission_requests
     SET status = ?, decided_by = ?, decision_message = ?, decided_at = ?
     WHERE id = ? AND status = 'pending'`
  ).run(status, decidedBy, message, now, id);

  if (result.changes === 0) return undefined;
  return get(db, id);
}

export function markTimeout(db: Database.Database, id: number, now: number): void {
  stmt(
    db,
    `UPDATE permission_requests SET status = 'timeout', decided_at = ? WHERE id = ? AND status = 'pending'`
  ).run(now, id);
}

export function listPending(db: Database.Database): PermissionRow[] {
  return stmt(
    db,
    `SELECT * FROM permission_requests WHERE status = 'pending' ORDER BY created_at ASC`
  ).all() as PermissionRow[];
}

export function list(db: Database.Database, status?: PermissionStatus, limit = 50): PermissionRow[] {
  if (status) {
    return stmt(
      db,
      'SELECT * FROM permission_requests WHERE status = ? ORDER BY id DESC LIMIT ?'
    ).all(status, limit) as PermissionRow[];
  }
  return stmt(db, 'SELECT * FROM permission_requests ORDER BY id DESC LIMIT ?').all(
    limit
  ) as PermissionRow[];
}
