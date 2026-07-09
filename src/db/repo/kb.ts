import Database from 'better-sqlite3';
import type { KbNoteRow, KbSearchResult } from '../../types.js';

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

export function add(
  db: Database.Database,
  opts: { title: string; body: string; tags: string; author: string; now: number }
): KbNoteRow {
  const { title, body, tags, author, now } = opts;
  const result = stmt(
    db,
    'INSERT INTO kb_notes (title, body, tags, author_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(title, body, tags, author, now, now);

  return {
    id: Number(result.lastInsertRowid),
    title,
    body,
    tags,
    author_name: author,
    created_at: now,
    updated_at: now,
  };
}

export function get(db: Database.Database, id: number): KbNoteRow | undefined {
  return stmt(db, 'SELECT * FROM kb_notes WHERE id = ?').get(id) as KbNoteRow | undefined;
}

// FTS5 MATCH treats bare terms as query syntax (AND/OR/NOT/NEAR, prefix *, column filters);
// quoting each whitespace-split term makes arbitrary user input safe to match literally.
// Terms are OR-joined for recall (a multi-word query matching any one word still hits) —
// bm25 still ranks notes matching more terms higher, so precision survives.
function sanitizeTerms(query: string, strictAlnum: boolean): string {
  return query
    .split(/\s+/)
    .map((term) => (strictAlnum ? (term.match(/[A-Za-z0-9_]+/g) ?? []).join('') : term))
    .filter((term) => term.length > 0)
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(' OR ');
}

const SEARCH_SQL = `
  SELECT kb_notes.id AS id, kb_notes.title AS title, kb_notes.tags AS tags,
         snippet(kb_fts, 1, '[', ']', '…', 12) AS snippet,
         bm25(kb_fts, 5.0, 1.0, 3.0) AS rank
  FROM kb_fts
  JOIN kb_notes ON kb_notes.id = kb_fts.rowid
  WHERE kb_fts MATCH ?
  ORDER BY rank
  LIMIT ?
`;

export function search(db: Database.Database, query: string, limit = 5): KbSearchResult[] {
  const sanitized = sanitizeTerms(query, false);
  if (sanitized.length === 0) return [];

  try {
    return stmt(db, SEARCH_SQL).all(sanitized, limit) as KbSearchResult[];
  } catch (err) {
    // Still-malformed FTS5 syntax (e.g. a lone quote/paren) after quoting: retry with terms
    // stripped down to safe characters rather than failing the search outright.
    if (!(err instanceof Database.SqliteError)) throw err;
    const strict = sanitizeTerms(query, true);
    if (strict.length === 0) return [];
    return stmt(db, SEARCH_SQL).all(strict, limit) as KbSearchResult[];
  }
}

// --- kb_vec: vec0 virtual table (sqlite-vec), created at runtime by athen init — NOT in the
// migrations array, because the extension must be loaded into the connection before the DDL
// runs and the hub must still boot when the extension fails to load. Callers guarantee the
// table exists before using these.

export function upsertVec(db: Database.Database, noteId: number, vec: Float32Array): void {
  // vec0 has no ON CONFLICT support: delete + insert in one transaction. The PK must be bound
  // as BigInt — vec0's xUpdate rejects better-sqlite3's number binding as non-integer.
  const run = db.transaction(() => {
    stmt(db, 'DELETE FROM kb_vec WHERE note_id = ?').run(noteId);
    stmt(db, 'INSERT INTO kb_vec (note_id, embedding) VALUES (?, ?)').run(
      BigInt(noteId),
      Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)
    );
  });
  run();
}

export function knnVec(
  db: Database.Database,
  vec: Float32Array,
  k: number
): { note_id: number; distance: number }[] {
  // Vectors are L2-normalized at embed time, so default L2 distance ranks identically to cosine.
  return stmt(db, 'SELECT note_id, distance FROM kb_vec WHERE embedding MATCH ? AND k = ? ORDER BY distance').all(
    Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength),
    k
  ) as { note_id: number; distance: number }[];
}

export function notesMissingVec(db: Database.Database, limit: number): KbNoteRow[] {
  return stmt(
    db,
    `SELECT n.* FROM kb_notes n LEFT JOIN kb_vec v ON v.note_id = n.id
     WHERE v.note_id IS NULL ORDER BY n.id LIMIT ?`
  ).all(limit) as KbNoteRow[];
}
