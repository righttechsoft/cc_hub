import { open, stat } from 'node:fs/promises';
import type Database from 'better-sqlite3';
import type { Logger } from '../types.js';
import * as sessions from '../db/repo/sessions.js';

// Marker strings CC writes into the transcript when a turn dies on a usage limit. Kept in one
// exported const so CC-version drift is a one-line fix.
export const LIMIT_MARKER_RE =
  /usage limit reached|rate.?limit(ed)?|limit will reset|resets? at |waiting for .{0,20}limit|out of (usage|quota)/i;

// A marker alone is not enough: cc_hub's own sessions *talk about* usage limits in ordinary
// conversation content, so the matched line must also look like an API error / system entry.
const LINE_HINTS = ['"isApiErrorMessage":true', '"type":"system"'];

const TAIL_BYTES = 64 * 1024;

const TIMESTAMP_RE = /"timestamp":"([^"]+)"/;

export interface TranscriptScanDeps {
  db: Database.Database;
  log: Logger;
  windowMs: number;
  now: number;
}

// Called by the limit watcher at continue time (after reset confirmed): finds idle sessions whose
// transcript tail shows a fresh limit marker — i.e. sessions whose turn was killed by the limit,
// however long ago they went idle. Returns matching session ids; fail-soft per file.
export async function scanTranscriptsForLimitHits(deps: TranscriptScanDeps): Promise<string[]> {
  const { db, log, windowMs, now } = deps;
  const hits: string[] = [];

  for (const session of sessions.idleSessionsWithTranscripts(db)) {
    const path = session.transcript_path;
    if (!path) continue;
    try {
      const st = await stat(path);
      // A transcript untouched for the whole window can't contain a fresh marker — skip the read.
      if (st.mtimeMs < now - windowMs) continue;

      const tail = await readTail(path, st.size);
      if (tailHasFreshMarker(tail, st.mtimeMs, windowMs, now)) hits.push(session.id);
    } catch (err) {
      log.debug('transcriptScan: skipping unreadable transcript', {
        session: session.id,
        path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return hits;
}

async function readTail(path: string, size: number): Promise<string> {
  const len = Math.min(size, TAIL_BYTES);
  if (len === 0) return '';
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

function tailHasFreshMarker(tail: string, mtimeMs: number, windowMs: number, now: number): boolean {
  const lines = tail.split('\n');
  // Newest lines are at the end; the first marker found walking backwards is the most recent one,
  // so its staleness verdict is final for the whole file.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!LIMIT_MARKER_RE.test(line)) continue;
    if (!LINE_HINTS.some((hint) => line.includes(hint))) continue;

    const ts = TIMESTAMP_RE.exec(line);
    if (ts) {
      const parsed = Date.parse(ts[1]);
      // The tail's first line is usually truncated mid-JSON, so an unparseable timestamp falls
      // through to the mtime check rather than being treated as evidence either way.
      if (!Number.isNaN(parsed)) return parsed >= now - windowMs;
    }
    return mtimeMs >= now - windowMs;
  }
  return false;
}
