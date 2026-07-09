import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../db/migrations.js';
import { scanTranscriptsForLimitHits } from './transcriptScan.js';
import type { Logger } from '../types.js';

const WINDOW_MS = 6 * 60 * 60_000;

let dir: string;
let fileCounter = 0;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-hub-scan-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function silentLogger(): Logger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function insertSession(
  db: Database.Database,
  id: string,
  transcriptPath: string | null,
  status: 'idle' | 'active' = 'idle'
): void {
  const now = Date.now();
  const info = db
    .prepare('INSERT INTO instances (name, cwd, alias, first_seen_at, last_seen_at) VALUES (?, ?, NULL, ?, ?)')
    .run(`inst-${id}`, `/proj-${id}`, now, now);
  db.prepare(
    `INSERT INTO sessions
      (id, instance_id, cwd, transcript_path, status, started_at, last_event_at, auto_continue, continues_today, continues_date)
     VALUES (?, ?, '/proj', ?, ?, ?, ?, 1, 0, NULL)`
  ).run(id, Number(info.lastInsertRowid), transcriptPath, status, now, now);
}

function writeTranscript(lines: string[]): string {
  const path = join(dir, `transcript-${fileCounter++}.jsonl`);
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
  return path;
}

// A realistic CC transcript line for a turn killed by the usage limit.
function apiErrorMarkerLine(isoTimestamp: string | null): string {
  const obj: Record<string, unknown> = {
    type: 'assistant',
    isApiErrorMessage: true,
    message: { content: [{ type: 'text', text: 'Claude usage limit reached. Your limit will reset at 3pm.' }] },
  };
  if (isoTimestamp) obj.timestamp = isoTimestamp;
  return JSON.stringify(obj);
}

function ordinaryLine(text: string): string {
  return JSON.stringify({
    type: 'user',
    timestamp: new Date().toISOString(),
    message: { content: text },
  });
}

async function scan(db: Database.Database, now = Date.now()): Promise<string[]> {
  return scanTranscriptsForLimitHits({ db, log: silentLogger(), windowMs: WINDOW_MS, now });
}

describe('scanTranscriptsForLimitHits', () => {
  it('returns an idle session whose transcript tail has a fresh api-error limit marker', async () => {
    const db = buildDb();
    const path = writeTranscript([
      ordinaryLine('working on the thing'),
      apiErrorMarkerLine(new Date(Date.now() - 60_000).toISOString()),
    ]);
    insertSession(db, 'sess-fresh', path);

    expect(await scan(db)).toEqual(['sess-fresh']);
  });

  it('ignores a marker whose timestamp is older than the window even if the file is fresh', async () => {
    const db = buildDb();
    const path = writeTranscript([
      apiErrorMarkerLine(new Date(Date.now() - 12 * 60 * 60_000).toISOString()),
    ]);
    insertSession(db, 'sess-stale-marker', path);

    expect(await scan(db)).toEqual([]);
  });

  it('ignores limit talk in ordinary conversation content (no api-error/system hint on the line)', async () => {
    const db = buildDb();
    const path = writeTranscript([
      ordinaryLine('we hit the usage limit reached case yesterday, resets at 3pm apparently'),
    ]);
    insertSession(db, 'sess-chatter', path);

    expect(await scan(db)).toEqual([]);
  });

  it('skips a file whose mtime is older than the window without reading it', async () => {
    const db = buildDb();
    const path = writeTranscript([apiErrorMarkerLine(new Date().toISOString())]);
    const oldSeconds = (Date.now() - 2 * WINDOW_MS) / 1000;
    utimesSync(path, oldSeconds, oldSeconds);
    insertSession(db, 'sess-old-file', path);

    expect(await scan(db)).toEqual([]);
  });

  it('is fail-soft: an unreadable transcript does not block other sessions', async () => {
    const db = buildDb();
    insertSession(db, 'sess-missing', join(dir, 'does-not-exist.jsonl'));
    const goodPath = writeTranscript([apiErrorMarkerLine(new Date().toISOString())]);
    insertSession(db, 'sess-good', goodPath);

    expect(await scan(db)).toEqual(['sess-good']);
  });

  it('finds a marker at the end of a transcript larger than the 64KB tail read', async () => {
    const db = buildDb();
    const filler = Array.from({ length: 1500 }, (_, i) => ordinaryLine(`filler line ${i} `.repeat(5)));
    const path = writeTranscript([...filler, apiErrorMarkerLine(new Date().toISOString())]);
    insertSession(db, 'sess-big', path);

    expect(await scan(db)).toEqual(['sess-big']);
  });

  it('falls back to file mtime when the marker line has no parseable timestamp', async () => {
    const db = buildDb();
    const path = writeTranscript([apiErrorMarkerLine(null)]);
    insertSession(db, 'sess-no-ts', path);

    expect(await scan(db)).toEqual(['sess-no-ts']);
  });

  it('only scans idle sessions', async () => {
    const db = buildDb();
    const path = writeTranscript([apiErrorMarkerLine(new Date().toISOString())]);
    insertSession(db, 'sess-active', path, 'active');

    expect(await scan(db)).toEqual([]);
  });
});
