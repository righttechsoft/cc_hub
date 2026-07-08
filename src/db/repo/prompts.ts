import type Database from 'better-sqlite3';
import type { PendingPromptRow, PendingPromptSource, PendingPromptStatus } from '../../types.js';

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

export function enqueue(
  db: Database.Database,
  opts: {
    sessionId: string;
    prompt: string;
    source: PendingPromptSource;
    status: PendingPromptStatus;
    now: number;
  }
): PendingPromptRow {
  const { sessionId, prompt, source, status, now } = opts;
  const result = stmt(
    db,
    'INSERT INTO pending_prompts (session_id, prompt, source, status, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(sessionId, prompt, source, status, now);

  return {
    id: Number(result.lastInsertRowid),
    session_id: sessionId,
    prompt,
    source,
    status,
    created_at: now,
    delivered_at: null,
    error: null,
  };
}

export function nextQueued(db: Database.Database, sessionId: string): PendingPromptRow | undefined {
  return stmt(
    db,
    `SELECT * FROM pending_prompts WHERE session_id = ? AND status = 'queued' ORDER BY id ASC LIMIT 1`
  ).get(sessionId) as PendingPromptRow | undefined;
}

export function setStatus(
  db: Database.Database,
  id: number,
  status: PendingPromptStatus,
  error?: string
): void {
  if (status === 'delivered') {
    stmt(db, 'UPDATE pending_prompts SET status = ?, delivered_at = ?, error = ? WHERE id = ?').run(
      status,
      Date.now(),
      error ?? null,
      id
    );
  } else {
    stmt(db, 'UPDATE pending_prompts SET status = ?, error = ? WHERE id = ?').run(
      status,
      error ?? null,
      id
    );
  }
}

export function listForSession(db: Database.Database, sessionId: string): PendingPromptRow[] {
  return stmt(
    db,
    'SELECT * FROM pending_prompts WHERE session_id = ? ORDER BY id ASC'
  ).all(sessionId) as PendingPromptRow[];
}
