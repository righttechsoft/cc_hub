import type Database from 'better-sqlite3';
import type { SessionRow, SessionStatus, SessionJoined, InstanceRow } from '../../types.js';

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

export function get(db: Database.Database, id: string): SessionRow | undefined {
  return stmt(db, 'SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
}

export function upsertFromHook(
  db: Database.Database,
  opts: {
    sessionId: string;
    cwd: string;
    transcriptPath: string | null;
    instanceId: number;
    now: number;
  }
): SessionRow {
  const { sessionId, cwd, transcriptPath, instanceId, now } = opts;
  const existing = get(db, sessionId);
  if (existing) {
    stmt(db, 'UPDATE sessions SET last_event_at = ?, transcript_path = ? WHERE id = ?').run(
      now,
      transcriptPath,
      sessionId
    );
    return { ...existing, last_event_at: now, transcript_path: transcriptPath };
  }

  stmt(
    db,
    `INSERT INTO sessions (id, instance_id, cwd, transcript_path, status, started_at, last_event_at, auto_continue, continues_today)
     VALUES (?, ?, ?, ?, 'active', ?, ?, 1, 0)`
  ).run(sessionId, instanceId, cwd, transcriptPath, now, now);

  return {
    id: sessionId,
    instance_id: instanceId,
    cwd,
    transcript_path: transcriptPath,
    status: 'active',
    started_at: now,
    last_event_at: now,
    ended_at: null,
    last_prompt: null,
    mcp_session_id: null,
    resumed_from: null,
    auto_continue: 1,
    continues_today: 0,
    continues_date: null,
    interrupted_at: null,
    session_name: null,
  };
}

// Statusline-reported Claude Code session name (what `/name <x>` sets, or CC's own auto-generated
// conversation title — see CLAUDE.md's "Session names" subsection). Caller (hooksRoutes.ts's
// POST /hooks/session-name) has already checked the session row exists. `now` is accepted for
// signature symmetry with the repo's other setters but unused — a session-name report is not a
// recency signal worth touching last_event_at for.
export function setSessionName(db: Database.Database, id: string, name: string, _now: number): void {
  stmt(db, 'UPDATE sessions SET session_name = ? WHERE id = ?').run(name, id);
}

// Every status transition also refreshes last_event_at so downstream recency checks (interrupted
// candidate detection, chat_peers liveness) reflect real event timing, not just the last prompt.
export function setStatus(db: Database.Database, id: string, status: SessionStatus, now: number): void {
  if (status === 'ended') {
    stmt(db, 'UPDATE sessions SET status = ?, ended_at = ?, last_event_at = ? WHERE id = ?').run(
      status,
      now,
      now,
      id
    );
  } else {
    stmt(db, 'UPDATE sessions SET status = ?, last_event_at = ? WHERE id = ?').run(status, now, id);
  }
}

// For hooks (Notification, PermissionRequest) that don't change status but should still count
// as recent activity for recency checks.
export function touchLastEventAt(db: Database.Database, id: string, now: number): void {
  stmt(db, 'UPDATE sessions SET last_event_at = ? WHERE id = ?').run(now, id);
}

export function setLastPrompt(db: Database.Database, id: string, preview500: string): void {
  stmt(db, 'UPDATE sessions SET last_prompt = ? WHERE id = ?').run(preview500, id);
}

export function getJoined(db: Database.Database, id: string): SessionJoined | undefined {
  return stmt(
    db,
    `SELECT sessions.*, instances.name AS instance_name
     FROM sessions
     LEFT JOIN instances ON instances.id = sessions.instance_id
     WHERE sessions.id = ?`
  ).get(id) as SessionJoined | undefined;
}

export function listJoined(db: Database.Database, filter?: { status?: string[] }): SessionJoined[] {
  const statuses = filter?.status;
  if (statuses && statuses.length > 0) {
    const placeholders = statuses.map(() => '?').join(', ');
    return stmt(
      db,
      `SELECT sessions.*, instances.name AS instance_name
       FROM sessions
       LEFT JOIN instances ON instances.id = sessions.instance_id
       WHERE sessions.status IN (${placeholders})
       ORDER BY sessions.last_event_at DESC`
    ).all(...statuses) as SessionJoined[];
  }
  return stmt(
    db,
    `SELECT sessions.*, instances.name AS instance_name
     FROM sessions
     LEFT JOIN instances ON instances.id = sessions.instance_id
     ORDER BY sessions.last_event_at DESC`
  ).all() as SessionJoined[];
}

// Snapshot taken at limit-detection time: sessions mid-turn (active) always qualify regardless
// of last_event_at age (a long-running turn with no intervening Notification is still genuinely
// active); sessions that went idle very recently (Stop fired within the last 5 min) also qualify,
// additionally bounded by windowMs so a stale idle session isn't resurrected.
export function markInterruptedCandidates(
  db: Database.Database,
  windowMs: number,
  now: number
): SessionRow[] {
  const idleCutoff = now - 5 * 60_000;
  const staleCutoff = now - windowMs;

  const rows = stmt(
    db,
    `SELECT * FROM sessions
     WHERE status = 'active'
        OR (status = 'idle' AND last_event_at >= ? AND last_event_at >= ?)`
  ).all(idleCutoff, staleCutoff) as SessionRow[];

  if (rows.length === 0) return [];

  const update = stmt(db, `UPDATE sessions SET status = 'interrupted', interrupted_at = ? WHERE id = ?`);
  const applyAll = db.transaction((ids: string[]) => {
    for (const id of ids) update.run(now, id);
  });
  applyAll(rows.map((r) => r.id));

  return rows.map((r) => ({ ...r, status: 'interrupted' as const, interrupted_at: now }));
}

export function interruptedSessions(db: Database.Database): SessionRow[] {
  return stmt(
    db,
    `SELECT * FROM sessions WHERE status = 'interrupted' ORDER BY interrupted_at ASC`
  ).all() as SessionRow[];
}

// Candidates for the continue-time transcript scan (src/limit/transcriptScan.ts): every idle
// session, however old — marker recency is enforced against the transcript itself, not
// last_event_at, so a session limited hours ago (or while the hub was down) still qualifies.
export function idleSessionsWithTranscripts(db: Database.Database): SessionRow[] {
  return stmt(
    db,
    `SELECT * FROM sessions WHERE status = 'idle' AND transcript_path IS NOT NULL`
  ).all() as SessionRow[];
}

// Marks scan-selected sessions for continuation, joining them onto the same 'interrupted' track
// the ->limited snapshot uses so interruptedSessions/resetInterruptedToIdle work unchanged.
export function markInterrupted(db: Database.Database, ids: string[], now: number): void {
  if (ids.length === 0) return;
  const update = stmt(
    db,
    `UPDATE sessions SET status = 'interrupted', interrupted_at = ? WHERE id = ? AND status != 'ended'`
  );
  const applyAll = db.transaction((sessionIds: string[]) => {
    for (const id of sessionIds) update.run(now, id);
  });
  applyAll(ids);
}

export function resetInterruptedToIdle(db: Database.Database): void {
  stmt(db, `UPDATE sessions SET status = 'idle' WHERE status = 'interrupted'`).run();
}

export function setAutoContinue(db: Database.Database, id: string, enabled: boolean): void {
  stmt(db, 'UPDATE sessions SET auto_continue = ? WHERE id = ?').run(enabled ? 1 : 0, id);
}

export function bumpContinues(db: Database.Database, id: string, dateStr: string): void {
  const row = get(db, id);
  if (!row) return;
  if (row.continues_date !== dateStr) {
    stmt(db, 'UPDATE sessions SET continues_today = 1, continues_date = ? WHERE id = ?').run(
      dateStr,
      id
    );
  } else {
    stmt(db, 'UPDATE sessions SET continues_today = continues_today + 1 WHERE id = ?').run(id);
  }
}

export function bindMcp(db: Database.Database, sessionId: string, mcpSessionId: string): void {
  stmt(db, 'UPDATE sessions SET mcp_session_id = ? WHERE id = ?').run(mcpSessionId, sessionId);
}

export function linkResumedFrom(db: Database.Database, newSessionId: string, oldSessionId: string): void {
  stmt(db, 'UPDATE sessions SET resumed_from = ? WHERE id = ?').run(oldSessionId, newSessionId);
}

// chatDelivery: an instance mid-turn already gets its mail through the normal hooks (Stop
// urgent-block / next UserPromptSubmit) — this is the guard that keeps chatDelivery from
// starting a second, redundant session alongside a turn that's actively running.
export function hasActiveSession(db: Database.Database, instanceId: number): boolean {
  const row = stmt(db, `SELECT id FROM sessions WHERE instance_id = ? AND status = 'active' LIMIT 1`).get(
    instanceId
  ) as { id: string } | undefined;
  return row !== undefined;
}

// hub_register's tier-3 resolution (see CLAUDE.md's Identity model): an MCP-calling agent inside
// a dispatched, NAMED cc-attach terminal often calls hub_register with only `cwd` — models don't
// reliably pass `session_id`/`name` even when the SessionStart banner tells them their identity.
// Resolving purely from cwd would then collapse that agent's chat identity into the folder's
// cwd-derived default instance, alongside every other unnamed session in the same directory. This
// is the fallback: the sole non-ended session in this cwd (NOCASE) that's bound to a NAMED
// instance. Returns that instance only when exactly one DISTINCT named instance matches — zero or
// more than one is ambiguous (e.g. two concurrent named task agents sharing a folder) and must
// fall through to the cwd default rather than risk misrouting one task's mail to another.
export function soleActiveNamedInstanceForCwd(db: Database.Database, cwd: string): InstanceRow | undefined {
  const rows = stmt(
    db,
    `SELECT DISTINCT instances.id, instances.name, instances.cwd, instances.alias,
            instances.first_seen_at, instances.last_seen_at, instances.app_url, instances.app_url_at, instances.named
     FROM sessions
     JOIN instances ON instances.id = sessions.instance_id
     WHERE sessions.cwd = ? COLLATE NOCASE
       AND sessions.status != 'ended'
       AND instances.named = 1`
  ).all(cwd) as InstanceRow[];

  return rows.length === 1 ? rows[0] : undefined;
}

// Dispatcher confirmation (src/spawn/dispatcher.ts): whether any session belonging to the target
// instance is currently active — resolved primarily by instance NAME (the dispatch name), falling
// back to matching on `cwd` for the case the instance row itself doesn't exist yet at poll time
// (a brand-new spawn's instance isn't created until its SessionStart hook fires). A single OR'd
// query rather than a name-then-cwd resolution dance — see CLAUDE.md's dispatch confirmation
// subsection.
export function hasActiveSessionForInstance(db: Database.Database, name: string, cwd: string): boolean {
  const row = stmt(
    db,
    `SELECT sessions.id FROM sessions
     LEFT JOIN instances ON instances.id = sessions.instance_id
     WHERE sessions.status = 'active' AND (instances.name = ? OR sessions.cwd = ? COLLATE NOCASE)
     LIMIT 1`
  ).get(name, cwd) as { id: string } | undefined;
  return row !== undefined;
}

// Stale-session reaper candidates (src/sessions/reaper.ts): every non-ended session whose
// last_event_at is more than olderThanMs milliseconds in the past, regardless of status
// ('active'/'idle'/'interrupted'/'continuing' — a force-killed terminal can leave a session
// stuck in any of these). instance_name comes along via the join so the reaper can check the
// resolved name against the attach registry without a second query per row.
export function listStale(db: Database.Database, olderThanMs: number): SessionJoined[] {
  const cutoff = Date.now() - olderThanMs;
  return stmt(
    db,
    `SELECT sessions.*, instances.name AS instance_name
     FROM sessions
     LEFT JOIN instances ON instances.id = sessions.instance_id
     WHERE sessions.status != 'ended' AND sessions.last_event_at < ?
     ORDER BY sessions.last_event_at ASC`
  ).all(cutoff) as SessionJoined[];
}

export function findRecentByCwd(
  db: Database.Database,
  cwd: string,
  sinceMs: number,
  now: number
): SessionRow[] {
  const cutoff = now - sinceMs;
  return stmt(
    db,
    'SELECT * FROM sessions WHERE cwd = ? AND last_event_at >= ? ORDER BY last_event_at DESC'
  ).all(cwd, cutoff) as SessionRow[];
}
