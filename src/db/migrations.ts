import type Database from 'better-sqlite3';

interface Migration {
  version: number;
  sql: string;
  // Set for a migration that rebuilds a table other tables hold a FOREIGN KEY reference to (SQLite
  // has no ALTER TABLE DROP CONSTRAINT, so dropping e.g. a UNIQUE constraint means create-new/copy/
  // drop-old/rename). With foreign_keys=ON (production's openDb() sets this before ever calling
  // runMigrations), dropping a table referenced by another's FK raises "FOREIGN KEY constraint
  // failed" even though the rename immediately restores an equivalent table under the same name —
  // SQLite's FK checker doesn't treat a DROP immediately followed by a same-named RENAME as one
  // atomic "the parent still exists" operation. The fix — pragma foreign_keys=OFF around the rebuild — is
  // itself a no-op if attempted *inside* a transaction, so migrations flagging this run OUTSIDE the
  // normal per-migration transaction wrapper below (own transaction, own commit) instead.
  disableForeignKeys?: boolean;
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
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS push_tokens (
        token TEXT PRIMARY KEY,
        platform TEXT NOT NULL DEFAULT 'ios',
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 4,
    sql: 'ALTER TABLE messages ADD COLUMN summary TEXT',
  },
  {
    version: 5,
    sql: `
      ALTER TABLE instances ADD COLUMN app_url TEXT;
      ALTER TABLE instances ADD COLUMN app_url_at INTEGER;
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE IF NOT EXISTS instance_apps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id INTEGER NOT NULL REFERENCES instances(id),
        label TEXT NOT NULL,
        url TEXT,
        updated_at INTEGER NOT NULL,
        UNIQUE(instance_id, label)
      );
    `,
  },
  {
    // Named per-task agent identities (cc-attach --name / CC_HUB_NAME / hub_register name): a
    // single project directory can now host more than one instance identity at once (e.g. two
    // named agents working different tasks in the same repo), so `cwd` can no longer be UNIQUE.
    // SQLite has no ALTER TABLE DROP CONSTRAINT, so the table is rebuilt. `named` distinguishes
    // the single cwd-derived "default" identity (named=0, at most one per cwd — the pre-existing
    // one-identity-per-folder behavior) from explicitly-named siblings (named=1, any number per
    // cwd) — see src/core/identity.ts's resolveExplicitInstanceName / instances repo's byCwd.
    version: 7,
    disableForeignKeys: true,
    sql: `
      CREATE TABLE instances_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        cwd TEXT NOT NULL,
        alias TEXT,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        app_url TEXT,
        app_url_at INTEGER,
        named INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO instances_new (id, name, cwd, alias, first_seen_at, last_seen_at, app_url, app_url_at, named)
        SELECT id, name, cwd, alias, first_seen_at, last_seen_at, app_url, app_url_at, 0 FROM instances;
      DROP TABLE instances;
      ALTER TABLE instances_new RENAME TO instances;
      CREATE INDEX IF NOT EXISTS idx_instances_cwd ON instances(cwd);
    `,
  },
  {
    // Session names (see CLAUDE.md's "Session names" subsection): the statusline reports what
    // Claude Code's `/name <x>` sets (or its own auto-generated conversation title — the payload
    // carries no flag telling the two apart) to POST /hooks/session-name, which stores it here for
    // display and, when it looks like a deliberate short label (src/core/sessionNameIdentity.ts),
    // adopts it as the instance's identity. `name_source` tracks provenance so adoption never
    // silently overrides a name the user set explicitly (cc-attach --name / hub_register name /
    // the admin ✎ rename) — see src/core/identity.ts's applyInstanceRename.
    version: 8,
    sql: `
      ALTER TABLE sessions ADD COLUMN session_name TEXT;
      ALTER TABLE instances ADD COLUMN name_source TEXT NOT NULL DEFAULT 'cwd';
    `,
  },
];

function recordVersion(db: Database.Database, version: number): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(version));
}

export function runMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);

  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined;
  let currentVersion = row ? Number(row.value) : 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;

    if (migration.disableForeignKeys) {
      // PRAGMA foreign_keys is a no-op inside a transaction, so this one runs its own
      // transaction rather than reusing the shared wrapper below — see the Migration interface's
      // `disableForeignKeys` doc comment for why a table rebuild needs this at all.
      const fkWasOn = db.pragma('foreign_keys', { simple: true }) === 1;
      db.pragma('foreign_keys = OFF');
      try {
        const applyMigration = db.transaction(() => {
          db.exec(migration.sql);
          recordVersion(db, migration.version);
        });
        applyMigration();

        // The rebuild's own INSERT...SELECT should make this a no-op, but a real check costs
        // little and turns any future mistake here into a loud failure instead of silent
        // data-integrity corruption in a user's database.
        const violations = db.pragma('foreign_key_check') as unknown[];
        if (violations.length > 0) {
          throw new Error(
            `migrations: migration ${migration.version} left ${violations.length} foreign key violation(s)`
          );
        }
      } finally {
        if (fkWasOn) db.pragma('foreign_keys = ON');
      }
    } else {
      const applyMigration = db.transaction(() => {
        db.exec(migration.sql);
        recordVersion(db, migration.version);
      });

      applyMigration();
    }

    currentVersion = migration.version;
  }
}
