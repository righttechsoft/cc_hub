import type Database from 'better-sqlite3';
import type { InstanceNameSource, InstanceRow } from '../../types.js';

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

// The DEFAULT (unnamed, named=0) instance for a cwd — at most one ever exists (see instances
// repo's `upsert`/the migration v7 comment). COLLATE NOCASE so a case-variant path (Windows) or
// an explicitly-named sibling registered against the same cwd (see `upsertNamed`) never causes a
// duplicate default row. Named siblings are only found via `byName`/`listByCwd`.
export function byCwd(db: Database.Database, cwd: string): InstanceRow | undefined {
  return stmt(db, 'SELECT * FROM instances WHERE cwd = ? COLLATE NOCASE AND named = 0').get(cwd) as
    | InstanceRow
    | undefined;
}

// Every instance (default + any named siblings) currently registered against a cwd — used where
// a caller must account for named siblings instead of just the default identity (e.g. Overlord's
// liveness check). COLLATE NOCASE, same reasoning as byCwd.
export function listByCwd(db: Database.Database, cwd: string): InstanceRow[] {
  return stmt(db, 'SELECT * FROM instances WHERE cwd = ? COLLATE NOCASE').all(cwd) as InstanceRow[];
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

// Default (unnamed) identity: cwd is the identity key among named=0 rows (name collisions for
// the cwd-derived name are pre-resolved by the caller — core/identity.ts's instanceNameFromCwd —
// before this is called).
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
    "INSERT INTO instances (name, cwd, alias, first_seen_at, last_seen_at, named, name_source) VALUES (?, ?, NULL, ?, ?, 0, 'cwd')"
  ).run(name, cwd, now, now);

  return {
    id: Number(result.lastInsertRowid),
    name,
    cwd,
    alias: null,
    first_seen_at: now,
    last_seen_at: now,
    app_url: null,
    app_url_at: null,
    named: 0,
    name_source: 'cwd',
  };
}

// Explicitly-named identity (cc-attach --name / CC_HUB_NAME / hub_register name): identity key is
// `name` (globally UNIQUE), not cwd — several of these can share one cwd. The caller
// (core/identity.ts's resolveExplicitInstanceName) has already resolved `name` to either an
// existing row for this exact cwd (reuse) or a fresh, collision-free name (create); this function
// trusts that and never re-derives it.
export function upsertNamed(
  db: Database.Database,
  opts: { name: string; cwd: string; now: number }
): InstanceRow {
  const { name, cwd, now } = opts;
  const existing = byName(db, name);
  if (existing) {
    stmt(db, 'UPDATE instances SET last_seen_at = ? WHERE id = ?').run(now, existing.id);
    return { ...existing, last_seen_at: now };
  }

  const result = stmt(
    db,
    "INSERT INTO instances (name, cwd, alias, first_seen_at, last_seen_at, named, name_source) VALUES (?, ?, NULL, ?, ?, 1, 'explicit')"
  ).run(name, cwd, now, now);

  return {
    id: Number(result.lastInsertRowid),
    name,
    cwd,
    alias: null,
    first_seen_at: now,
    last_seen_at: now,
    app_url: null,
    app_url_at: null,
    named: 1,
    name_source: 'explicit',
  };
}

// Admin-page rename (running instances, no restart required — see apiRoutes.ts's
// POST /admin/instances/rename) and session-name adoption (src/http/hooksRoutes.ts's
// POST /hooks/session-name, via src/core/identity.ts's applyInstanceRename). Caller has already
// validated the new name's format and checked for a collision with a DIFFERENT instance; this just
// writes it. `nameSource` defaults to 'explicit' (the admin rename's only caller historically) —
// adoption passes 'session' explicitly.
export function rename(
  db: Database.Database,
  id: number,
  newName: string,
  nameSource: InstanceNameSource = 'explicit'
): void {
  stmt(db, 'UPDATE instances SET name = ?, name_source = ? WHERE id = ?').run(newName, nameSource, id);
}

// Session-name adoption (src/http/hooksRoutes.ts) flips a cwd-derived default identity into an
// explicitly-named one the first time its session_name is auto-adopted — see CLAUDE.md's "Session
// names" subsection. Never used to flip the other direction.
export function markNamed(db: Database.Database, id: number): void {
  stmt(db, 'UPDATE instances SET named = 1 WHERE id = ?').run(id);
}

export function byId(db: Database.Database, id: number): InstanceRow | undefined {
  return stmt(db, 'SELECT * FROM instances WHERE id = ?').get(id) as InstanceRow | undefined;
}

export function setAppUrl(db: Database.Database, id: number, url: string, now: number): void {
  stmt(db, 'UPDATE instances SET app_url = ?, app_url_at = ? WHERE id = ?').run(url, now, id);
}

// Instances that have told the hub a URL, most recently updated first — feeds the admin page's
// persistent footer (see src/http/adminUi.ts's renderInstanceUrls).
export function listWithAppUrl(db: Database.Database): InstanceRow[] {
  return stmt(
    db,
    'SELECT * FROM instances WHERE app_url IS NOT NULL ORDER BY app_url_at DESC'
  ).all() as InstanceRow[];
}
