// Athen — the shared know-how store. Wraps the kb_notes repo with hybrid search: FTS5 (lexical)
// fused with sqlite-vec KNN over local embeddings (semantic). Every embedding/vector failure
// degrades to FTS-only; notes themselves are never at risk.
import * as sqliteVec from 'sqlite-vec';
import type Database from 'better-sqlite3';
import type { KbNoteRow, KbSearchResult, Logger } from '../types.js';
import * as kb from '../db/repo/kb.js';
import type { Embedder } from './embedder.js';

const META_MODEL_KEY = 'athen_vec_model';
const RRF_K = 60;
// Legs run deeper than the final limit so rank fusion has material to work with.
const LEG_POOL = 20;
const BACKFILL_DELAY_MS = 10_000;
const BACKFILL_BATCH = 16;
// MiniLM's window is 256 wordpiece tokens (~1000-1300 chars); 2000 chars caps tokenizer work,
// the model truncates the rest.
const EMBED_BODY_CHARS = 2000;
const SEMANTIC_SNIPPET_CHARS = 160;

export interface AthenDeps {
  db: Database.Database;
  log: Logger;
  embedder?: Embedder;
}

export interface Athen {
  save(opts: { title: string; body: string; tags: string; author: string }): Promise<KbNoteRow>;
  search(query: string, limit?: number): Promise<KbSearchResult[]>;
  stop(): void;
}

export function embedText(note: { title: string; tags: string; body: string }): string {
  return `${note.title}\n${note.tags}\n${note.body.slice(0, EMBED_BODY_CHARS)}`;
}

// Reciprocal rank fusion: score(id) = Σ over legs of 1 / (RRF_K + rank), rank 1-based.
// Higher = better; ids appearing in both legs outrank single-leg hits.
export function rrfMerge(legs: number[][], limit: number): { id: number; score: number }[] {
  const scores = new Map<number, number>();
  for (const leg of legs) {
    leg.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + i + 1)));
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id - b.id)
    .slice(0, limit);
}

function vecTableExists(db: Database.Database): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kb_vec'").get() !== undefined
  );
}

function metaGet(db: Database.Database, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

function metaSet(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

// Creates kb_vec at the embedding's dimension; a model switch (meta key mismatch) drops the
// table first — old vectors are garbage for a new model — and the backfill loop refills it.
// Not transactional: a crash mid-way self-heals (stale meta reads as a mismatch → recreate).
export function ensureVecTable(db: Database.Database, model: string, dim: number): void {
  const exists = vecTableExists(db);
  if (exists && metaGet(db, META_MODEL_KEY) === model) return;
  if (exists) db.exec('DROP TABLE IF EXISTS kb_vec');
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS kb_vec USING vec0(note_id INTEGER PRIMARY KEY, embedding float[${dim}])`
  );
  metaSet(db, META_MODEL_KEY, model);
}

export interface BackfillDeps {
  db: Database.Database;
  embedder: Embedder;
  ensureTable: (dim: number) => void;
  isStopped?: () => boolean;
}

// Embeds every note without a vector (pre-existing notes, previously failed saves, model
// switches). Throws on the first embed error — the caller warns and the remaining notes retry
// on the next hub start, staying findable via FTS meanwhile.
export async function backfillMissing(deps: BackfillDeps): Promise<number> {
  const { db, embedder, ensureTable, isStopped = () => false } = deps;
  let count = 0;

  // notesMissingVec needs kb_vec to exist; bootstrap the table off a probe embedding when the
  // hub has never embedded anything yet (dim is only known from actual model output).
  if (!vecTableExists(db)) {
    if ((db.prepare('SELECT COUNT(*) AS n FROM kb_notes').get() as { n: number }).n === 0) return 0;
    ensureTable((await embedder.embed('athen')).length);
  }

  for (;;) {
    if (isStopped()) return count;
    const batch = kb.notesMissingVec(db, BACKFILL_BATCH);
    if (batch.length === 0) return count;
    for (const note of batch) {
      if (isStopped()) return count;
      const vec = await embedder.embed(embedText(note));
      ensureTable(vec.length);
      kb.upsertVec(db, note.id, vec);
      count++;
    }
  }
}

export function createAthen(deps: AthenDeps): Athen {
  const { db, log, embedder } = deps;

  // The extension .dll failing to load must never block hub boot — athen runs FTS-only then.
  let vecReady = false;
  if (embedder) {
    try {
      sqliteVec.load(db);
      vecReady = true;
    } catch (err) {
      log.warn('athen: sqlite-vec load failed — semantic search disabled', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function ensureTable(dim: number): void {
    if (!embedder) return;
    ensureVecTable(db, embedder.model, dim);
  }

  let stopped = false;
  let backfillTimer: NodeJS.Timeout | undefined;
  if (embedder && vecReady) {
    // Delayed one-shot so hub startup isn't competing with the model load.
    backfillTimer = setTimeout(() => {
      backfillMissing({ db, embedder, ensureTable, isStopped: () => stopped })
        .then((n) => {
          if (n > 0) log.info(`athen: backfilled ${n} note embedding(s)`);
        })
        .catch((err) => {
          log.warn('athen: embedding backfill aborted', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }, BACKFILL_DELAY_MS);
    backfillTimer.unref(); // never hold the process open just for a pending backfill
  }

  return {
    async save(opts) {
      const note = kb.add(db, { ...opts, now: Date.now() });
      if (embedder && vecReady) {
        try {
          const vec = await embedder.embed(embedText(note));
          ensureTable(vec.length);
          kb.upsertVec(db, note.id, vec);
        } catch (err) {
          // Fail-soft: the note is saved and FTS-findable; backfill retries the vector later.
          log.warn('athen: embed failed, note saved without vector', {
            noteId: note.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return note;
    },

    async search(query, limit = 5) {
      const pool = Math.max(LEG_POOL, limit);
      const fts = kb.search(db, query, pool);

      let knnIds: number[] = [];
      // Meta model must match the live embedder: after a config model change but before the
      // backfill rebuild, stored vectors are in the old model's space — skip the leg.
      if (
        embedder &&
        vecReady &&
        vecTableExists(db) &&
        metaGet(db, META_MODEL_KEY) === embedder.model
      ) {
        try {
          const queryVec = await embedder.embed(query);
          knnIds = kb.knnVec(db, queryVec, pool).map((r) => r.note_id);
        } catch (err) {
          log.warn('athen: semantic search leg failed, falling back to FTS', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (knnIds.length === 0) return fts.slice(0, limit);

      const byId = new Map(fts.map((r) => [r.id, r]));
      const results: KbSearchResult[] = [];
      for (const { id, score } of rrfMerge([fts.map((r) => r.id), knnIds], limit)) {
        const ftsHit = byId.get(id);
        if (ftsHit) {
          results.push({ ...ftsHit, rank: score });
          continue;
        }
        const note = kb.get(db, id);
        if (!note) continue; // vector for a vanished note — nothing to show
        const truncated = note.body.length > SEMANTIC_SNIPPET_CHARS;
        results.push({
          id,
          title: note.title,
          tags: note.tags,
          snippet: note.body.slice(0, SEMANTIC_SNIPPET_CHARS) + (truncated ? '…' : ''),
          rank: score,
        });
      }
      return results;
    },

    stop() {
      stopped = true;
      if (backfillTimer) clearTimeout(backfillTimer);
    },
  };
}
