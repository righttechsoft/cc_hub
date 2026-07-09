import type Database from 'better-sqlite3';

interface Migration {
  version: number;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS instances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        cwd TEXT NOT NULL UNIQUE,
        alias TEXT,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        instance_id INTEGER NOT NULL REFERENCES instances(id),
        cwd TEXT NOT NULL,
        transcript_path TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        started_at INTEGER NOT NULL,
        last_event_at INTEGER NOT NULL,
        ended_at INTEGER,
        last_prompt TEXT,
        mcp_session_id TEXT,
        resumed_from TEXT,
        auto_continue INTEGER NOT NULL DEFAULT 1,
        continues_today INTEGER NOT NULL DEFAULT 0,
        continues_date TEXT,
        interrupted_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
      CREATE INDEX IF NOT EXISTS idx_sessions_instance ON sessions(instance_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_last_event_at ON sessions(last_event_at);

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_name TEXT NOT NULL,
        to_name TEXT,
        body TEXT NOT NULL,
        urgent INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS message_reads (
        message_id INTEGER NOT NULL REFERENCES messages(id),
        reader_name TEXT NOT NULL,
        read_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, reader_name)
      );

      CREATE TABLE IF NOT EXISTS kb_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '',
        author_name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(
        title, body, tags,
        content='kb_notes', content_rowid='id',
        tokenize='porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS kb_notes_ai AFTER INSERT ON kb_notes BEGIN
        INSERT INTO kb_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS kb_notes_ad AFTER DELETE ON kb_notes BEGIN
        INSERT INTO kb_fts(kb_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS kb_notes_au AFTER UPDATE ON kb_notes BEGIN
        INSERT INTO kb_fts(kb_fts, rowid, title, body, tags) VALUES ('delete', old.id, old.title, old.body, old.tags);
        INSERT INTO kb_fts(rowid, title, body, tags) VALUES (new.id, new.title, new.body, new.tags);
      END;

      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        instance_name TEXT,
        type TEXT NOT NULL,
        payload TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_events_session_id ON session_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_session_events_created_at ON session_events(created_at);

      CREATE TABLE IF NOT EXISTS pending_prompts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS permission_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        tool_input TEXT,
        raw TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        decided_by TEXT,
        decision_message TEXT,
        created_at INTEGER NOT NULL,
        decided_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS limit_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state TEXT NOT NULL DEFAULT 'unknown',
        utilization REAL,
        resets_at INTEGER,
        last_poll_at INTEGER,
        last_ok_poll_at INTEGER,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS limit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        detail TEXT,
        created_at INTEGER NOT NULL
      );

      INSERT OR IGNORE INTO limit_state (id, state) VALUES (1, 'unknown');
    `,
  },
  {
    version: 2,
    sql: 'ALTER TABLE message_reads ADD COLUMN via TEXT',
  },
];

export function runMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);

  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined;
  let currentVersion = row ? Number(row.value) : 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;

    const applyMigration = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare(
        `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(String(migration.version));
    });

    applyMigration();
    currentVersion = migration.version;
  }
}
