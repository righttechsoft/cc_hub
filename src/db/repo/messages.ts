import type Database from 'better-sqlite3';
import type { MessageRow } from '../../types.js';

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

export function send(
  db: Database.Database,
  opts: { from: string; to: string | null; body: string; urgent: boolean; now: number }
): MessageRow {
  const { from, to, body, urgent, now } = opts;
  const result = stmt(
    db,
    'INSERT INTO messages (from_name, to_name, body, urgent, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(from, to, body, urgent ? 1 : 0, now);

  return {
    id: Number(result.lastInsertRowid),
    from_name: from,
    to_name: to,
    body,
    urgent: urgent ? 1 : 0,
    created_at: now,
  };
}

// LEFT JOIN against per-reader read-receipts; NULL join row = unread. Excludes own messages
// and messages addressed to someone else (to_name NULL = broadcast, everyone's inbox).
export function unreadFor(db: Database.Database, name: string, limit = 20): MessageRow[] {
  return stmt(
    db,
    `SELECT m.* FROM messages m
     LEFT JOIN message_reads r ON r.message_id = m.id AND r.reader_name = ?
     WHERE r.message_id IS NULL
       AND m.from_name != ?
       AND (m.to_name = ? OR m.to_name IS NULL)
     ORDER BY m.created_at DESC
     LIMIT ?`
  ).all(name, name, name, limit) as MessageRow[];
}

export function markRead(db: Database.Database, ids: number[], reader: string, now: number, via?: string): void {
  if (ids.length === 0) return;
  const insert = stmt(
    db,
    'INSERT OR IGNORE INTO message_reads (message_id, reader_name, read_at, via) VALUES (?, ?, ?, ?)'
  );
  const applyAll = db.transaction((messageIds: number[]) => {
    for (const id of messageIds) insert.run(id, reader, now, via ?? null);
  });
  applyAll(ids);
}

// Chat-delivery FYI re-surface (see handleUserPromptSubmit): messages that were auto-delivered
// to a headless turn while this reader's session was idle, and haven't been surfaced to the
// reader's interactive terminal yet (via = 'chat_delivery', not yet flipped to
// 'chat_delivery_notified' by markChatDeliveryNotified below). Unbounded by time — the via flip
// already makes this one-shot, so an arbitrarily old undelivered FYI still surfaces.
export function listChatDeliveredUnnotified(db: Database.Database, reader: string): MessageRow[] {
  return stmt(
    db,
    `SELECT m.* FROM messages m
     JOIN message_reads r ON r.message_id = m.id AND r.reader_name = ?
     WHERE r.via = 'chat_delivery'
     ORDER BY m.created_at ASC`
  ).all(reader) as MessageRow[];
}

// One-shot marker: flips 'chat_delivery' rows to 'chat_delivery_notified' once the FYI has been
// surfaced to the reader, so the next UserPromptSubmit doesn't re-inject the same messages.
export function markChatDeliveryNotified(db: Database.Database, ids: number[], reader: string): void {
  if (ids.length === 0) return;
  const update = stmt(
    db,
    `UPDATE message_reads SET via = 'chat_delivery_notified' WHERE reader_name = ? AND message_id = ?`
  );
  const applyAll = db.transaction((messageIds: number[]) => {
    for (const id of messageIds) update.run(reader, id);
  });
  applyAll(ids);
}

// Unbounded by design (unlike unreadFor's paginated default): callers that gate on urgent-unread
// existence must see the exact same set they then render/mark-read, or an urgent message older
// than the general inbox page size would be detected but silently dropped from the response.
export function urgentUnreadFor(db: Database.Database, name: string): MessageRow[] {
  return stmt(
    db,
    `SELECT m.* FROM messages m
     LEFT JOIN message_reads r ON r.message_id = m.id AND r.reader_name = ?
     WHERE r.message_id IS NULL
       AND m.urgent = 1
       AND m.from_name != ?
       AND (m.to_name = ? OR m.to_name IS NULL)
     ORDER BY m.created_at DESC`
  ).all(name, name, name) as MessageRow[];
}

export function hasUrgentUnread(db: Database.Database, name: string): boolean {
  return urgentUnreadFor(db, name).length > 0;
}

export function listAll(db: Database.Database, limit = 50, beforeId?: number): MessageRow[] {
  if (beforeId !== undefined) {
    return stmt(db, 'SELECT * FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?').all(
      beforeId,
      limit
    ) as MessageRow[];
  }
  return stmt(db, 'SELECT * FROM messages ORDER BY id DESC LIMIT ?').all(limit) as MessageRow[];
}

// Retention: a direct message (to_name set) is purgeable once its single recipient has read it.
// A broadcast message (to_name NULL, delivered to every instance's inbox) is only purgeable once
// every currently-known instance (excluding the sender) has a read receipt for it — otherwise a
// single fast reader would silently delete it for every other recipient who hasn't read it yet.
// Fully unread messages are kept regardless of age, so a slow reader never silently loses a
// message. Deletes the message_reads rows first since they FK-reference messages.id and
// foreign_keys is ON.
export function purgeReadOlderThan(db: Database.Database, cutoffMs: number): number {
  const ids = (
    stmt(
      db,
      `SELECT m.id AS id FROM messages m
       WHERE m.created_at < ?
         AND (
           (m.to_name IS NOT NULL AND EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = m.id))
           OR (
             m.to_name IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM instances i
               WHERE i.name != m.from_name
                 AND NOT EXISTS (
                   SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.reader_name = i.name
                 )
             )
           )
         )`
    ).all(cutoffMs) as { id: number }[]
  ).map((row) => row.id);

  if (ids.length === 0) return 0;

  const deleteReads = stmt(db, 'DELETE FROM message_reads WHERE message_id = ?');
  const deleteMessage = stmt(db, 'DELETE FROM messages WHERE id = ?');
  const purge = db.transaction((messageIds: number[]) => {
    for (const id of messageIds) {
      deleteReads.run(id);
      deleteMessage.run(id);
    }
  });
  purge(ids);

  return ids.length;
}
