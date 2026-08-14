import type Database from 'better-sqlite3';
import type { InstanceAppJoined, InstanceAppRow } from '../../types.js';

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

// Replaces an instance's entire app list (delete + insert, transactional) — used by the
// hub_set_apps MCP tool, which always sends the caller's full current list (an empty array
// clears it).
export function replaceAll(
  db: Database.Database,
  instanceId: number,
  apps: { label: string; url?: string | null }[],
  now: number
): void {
  const del = stmt(db, 'DELETE FROM instance_apps WHERE instance_id = ?');
  const ins = stmt(
    db,
    'INSERT INTO instance_apps (instance_id, label, url, updated_at) VALUES (?, ?, ?, ?)'
  );
  const tx = db.transaction((rows: { label: string; url?: string | null }[]) => {
    del.run(instanceId);
    for (const row of rows) {
      ins.run(instanceId, row.label, row.url ?? null, now);
    }
  });
  tx(apps);
}

// Upserts a single labeled app, keyed by (instance_id, label) — used by hub_set_url's back-compat
// write and the auto-captured 'url' output-trigger notice, neither of which knows the caller's
// full app list the way hub_set_apps does.
export function upsert(
  db: Database.Database,
  instanceId: number,
  label: string,
  url: string | null,
  now: number
): void {
  stmt(
    db,
    `INSERT INTO instance_apps (instance_id, label, url, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(instance_id, label) DO UPDATE SET url = excluded.url, updated_at = excluded.updated_at`
  ).run(instanceId, label, url, now);
}

export function listForInstance(db: Database.Database, instanceId: number): InstanceAppRow[] {
  return stmt(
    db,
    'SELECT * FROM instance_apps WHERE instance_id = ? ORDER BY updated_at DESC'
  ).all(instanceId) as InstanceAppRow[];
}

// Every app across every instance, most recently updated first, joined with the owning
// instance's name — feeds the admin page's persistent footer (see src/http/adminUi.ts's
// renderInstanceApps) and is also read directly by an external statusline tool.
export function listAllJoined(db: Database.Database): InstanceAppJoined[] {
  return stmt(
    db,
    `SELECT instance_apps.*, instances.name AS instance_name
     FROM instance_apps
     JOIN instances ON instances.id = instance_apps.instance_id
     ORDER BY instance_apps.updated_at DESC`
  ).all() as InstanceAppJoined[];
}

// A bare URL needs a label (the table's identity key within an instance) for the single-URL
// callers that don't have one of their own — hub_set_url's back-compat write (src/mcp/tools.ts)
// and the auto-captured 'url' output-trigger notice (src/http/app.ts). host:port reads naturally
// in the admin footer (e.g. "localhost:5173"). Falls back to the raw url if it doesn't parse
// (shouldn't happen — both callers already validate the http(s) prefix first).
export function labelFromUrl(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}
