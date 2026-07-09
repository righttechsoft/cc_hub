import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrations.js';
import * as kb from '../db/repo/kb.js';
import { backfillMissing, createAthen, embedText, ensureVecTable, rrfMerge } from './athen.js';
import type { Embedder } from './embedder.js';
import type { Logger } from '../types.js';

function silentLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function normalize(v: number[]): Float32Array {
  const norm = Math.hypot(...v) || 1;
  return Float32Array.from(v.map((x) => x / norm));
}

// Keyword-bucket embedder: texts mentioning iOS-ish words share one vector, docker-ish words
// another — lets "iPhone application" match an iOS note that FTS misses entirely.
function bucketEmbedder(model = 'fake-model'): Embedder {
  return {
    model,
    embed: async (text) => {
      const t = text.toLowerCase();
      if (/(ios|iphone|apple|xcode)/.test(t)) return normalize([1, 0.1, 0]);
      if (/(docker|container)/.test(t)) return normalize([0, 1, 0.1]);
      return normalize([0.1, 0, 1]);
    },
  };
}

function throwingEmbedder(model = 'fake-model'): Embedder {
  return {
    model,
    embed: async () => {
      throw new Error('onnx exploded');
    },
  };
}

describe('rrfMerge', () => {
  it('ranks ids present in both legs above single-leg ids', () => {
    const merged = rrfMerge(
      [
        [1, 2, 3],
        [9, 2, 8],
      ],
      10
    );
    expect(merged[0].id).toBe(2);
  });

  it('respects the limit and tie-breaks deterministically by id', () => {
    const merged = rrfMerge([[5, 4]], 1);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe(5);

    // Same rank in separate legs = identical score → lower id first.
    const tied = rrfMerge([[7], [3]], 10);
    expect(tied.map((r) => r.id)).toEqual([3, 7]);
  });
});

describe('embedText', () => {
  it('includes title and tags and truncates the body', () => {
    const text = embedText({ title: 'T', tags: 'a b', body: 'x'.repeat(5000) });
    expect(text.startsWith('T\na b\n')).toBe(true);
    expect(text.length).toBe('T\na b\n'.length + 2000);
  });
});

describe('createAthen: save', () => {
  it('writes a kb_vec row alongside the note', async () => {
    const db = buildDb();
    const athen = createAthen({ db, log: silentLogger(), embedder: bucketEmbedder() });

    const note = await athen.save({ title: 'Build iOS apps', body: 'xcodebuild signing', tags: '', author: 'a' });

    const row = db.prepare('SELECT COUNT(*) AS n FROM kb_vec WHERE note_id = ?').get(note.id) as { n: number };
    expect(row.n).toBe(1);
    athen.stop();
  });

  it('is fail-soft when the embedder throws: note persists, warn logged, no vec row', async () => {
    const db = buildDb();
    const log = silentLogger();
    const athen = createAthen({ db, log, embedder: throwingEmbedder() });

    const note = await athen.save({ title: 'still saved', body: 'body', tags: '', author: 'a' });

    expect(kb.get(db, note.id)?.title).toBe('still saved');
    expect(log.warn).toHaveBeenCalledWith('athen: embed failed, note saved without vector', expect.anything());
    athen.stop();
  });
});

describe('createAthen: search', () => {
  it('finds a note by meaning when FTS has zero keyword overlap', async () => {
    const db = buildDb();
    const athen = createAthen({ db, log: silentLogger(), embedder: bucketEmbedder() });
    const ios = await athen.save({ title: 'Build iOS apps', body: 'xcodebuild signing steps', tags: '', author: 'a' });
    await athen.save({ title: 'Docker compose intro', body: 'containers and volumes', tags: '', author: 'a' });

    const results = await athen.search('how do I ship an iphone thing', 5);

    expect(results[0].id).toBe(ios.id);
    // Semantic-only hit: snippet is the body head, not an FTS snippet.
    expect(results[0].snippet.startsWith('xcodebuild signing')).toBe(true);
    athen.stop();
  });

  it('respects the limit on the fused path', async () => {
    const db = buildDb();
    const athen = createAthen({ db, log: silentLogger(), embedder: bucketEmbedder() });
    for (let i = 0; i < 3; i++) {
      await athen.save({ title: `apple note ${i}`, body: `ios detail ${i}`, tags: '', author: 'a' });
    }

    expect(await athen.search('iphone', 2)).toHaveLength(2);
    athen.stop();
  });

  it('returns plain FTS results when there is no embedder', async () => {
    const db = buildDb();
    const athen = createAthen({ db, log: silentLogger(), embedder: undefined });
    await athen.save({ title: 'Docker compose intro', body: 'containers and volumes', tags: '', author: 'a' });

    const results = await athen.search('docker', 5);
    expect(results).toEqual(kb.search(db, 'docker', 5));
    athen.stop();
  });

  it('falls back to FTS when the embedder throws at query time', async () => {
    const db = buildDb();
    const good = createAthen({ db, log: silentLogger(), embedder: bucketEmbedder() });
    await good.save({ title: 'Docker compose intro', body: 'containers and volumes', tags: '', author: 'a' });
    good.stop();

    const log = silentLogger();
    const broken = createAthen({ db, log, embedder: throwingEmbedder() });
    const results = await broken.search('docker', 5);

    expect(results).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith('athen: semantic search leg failed, falling back to FTS', expect.anything());
    broken.stop();
  });

  it('skips stale vectors after a model change until the rebuild happens', async () => {
    const db = buildDb();
    const oldAthen = createAthen({ db, log: silentLogger(), embedder: bucketEmbedder('model-a') });
    await oldAthen.save({ title: 'Build iOS apps', body: 'xcodebuild signing', tags: '', author: 'a' });
    oldAthen.stop();

    // New model, vectors not rebuilt yet: semantic leg must not query the old-model space.
    const newAthen = createAthen({ db, log: silentLogger(), embedder: bucketEmbedder('model-b') });
    const results = await newAthen.search('iphone', 5);
    expect(results).toEqual([]); // FTS has no 'iphone' match, semantic leg skipped
    newAthen.stop();
  });
});

describe('model switch + backfill', () => {
  it('save under a new model drops and recreates kb_vec (new dimension works)', async () => {
    const db = buildDb();
    const a = createAthen({ db, log: silentLogger(), embedder: bucketEmbedder('model-a') });
    await a.save({ title: 'Build iOS apps', body: 'xcodebuild', tags: '', author: 'a' });
    a.stop();

    const twoDim: Embedder = { model: 'model-b', embed: async () => normalize([1, 2]) };
    const b = createAthen({ db, log: silentLogger(), embedder: twoDim });
    const note = await b.save({ title: 'fresh', body: 'note', tags: '', author: 'a' });

    const rows = db.prepare('SELECT note_id FROM kb_vec ORDER BY note_id').all() as { note_id: number }[];
    expect(rows).toEqual([{ note_id: note.id }]); // old-model vector gone
    const meta = db.prepare("SELECT value FROM meta WHERE key = 'athen_vec_model'").get() as { value: string };
    expect(meta.value).toBe('model-b');
    b.stop();
  });

  it('backfillMissing embeds notes without vectors and skips embedded ones', async () => {
    const db = buildDb();
    const embedder = bucketEmbedder();
    const athen = createAthen({ db, log: silentLogger(), embedder });
    await athen.save({ title: 'embedded already', body: 'ios', tags: '', author: 'a' });
    kb.add(db, { title: 'orphan 1', body: 'docker', tags: '', author: 'a', now: Date.now() });
    kb.add(db, { title: 'orphan 2', body: 'other', tags: '', author: 'a', now: Date.now() });

    const count = await backfillMissing({ db, embedder, ensureTable: () => {} });

    expect(count).toBe(2);
    expect((db.prepare('SELECT COUNT(*) AS n FROM kb_vec').get() as { n: number }).n).toBe(3);
    athen.stop();
  });

  it('backfillMissing aborts on the first embed error', async () => {
    const db = buildDb();
    const good = bucketEmbedder();
    const athen = createAthen({ db, log: silentLogger(), embedder: good });
    await athen.save({ title: 'seed so table exists', body: 'ios', tags: '', author: 'a' });
    kb.add(db, { title: 'orphan', body: 'docker', tags: '', author: 'a', now: Date.now() });

    await expect(
      backfillMissing({ db, embedder: throwingEmbedder(), ensureTable: () => {} })
    ).rejects.toThrow('onnx exploded');
    athen.stop();
  });

  it('backfillMissing bootstraps the table from a probe embedding when it does not exist yet', async () => {
    const db = buildDb();
    const embedder = bucketEmbedder();
    kb.add(db, { title: 'pre-existing note', body: 'docker', tags: '', author: 'a', now: Date.now() });

    // No athen.save has ever run: kb_vec does not exist. createAthen loads the extension; call
    // backfill directly with the real DDL helper (the production timer is 10s out).
    const athen = createAthen({ db, log: silentLogger(), embedder });
    const count = await backfillMissing({
      db,
      embedder,
      ensureTable: (dim) => ensureVecTable(db, embedder.model, dim),
    });

    expect(count).toBe(1);
    athen.stop();
  });
});
