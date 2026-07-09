import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { runMigrations } from '../migrations.js';
import * as kb from './kb.js';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function buildVecDb(dim: number): Database.Database {
  const db = buildDb();
  sqliteVec.load(db);
  db.exec(`CREATE VIRTUAL TABLE kb_vec USING vec0(note_id INTEGER PRIMARY KEY, embedding float[${dim}])`);
  return db;
}

describe('kb notes', () => {
  it('add/get roundtrip', () => {
    const db = buildDb();
    const note = kb.add(db, { title: 'T', body: 'B', tags: 'x y', author: 'alpha', now: 123 });
    expect(kb.get(db, note.id)).toEqual(note);
  });

  it('OR-recall: a multi-word query where only one word matches still returns the note', () => {
    const db = buildDb();
    const note = kb.add(db, { title: 'Docker compose setup', body: 'volumes', tags: '', author: 'a', now: 1 });

    const results = kb.search(db, 'docker kubernetes helm', 5);
    expect(results.map((r) => r.id)).toEqual([note.id]);
  });

  it('never throws on hostile FTS input', () => {
    const db = buildDb();
    kb.add(db, { title: 'note', body: 'body', tags: '', author: 'a', now: 1 });

    for (const q of ['"', '(', 'NEAR(', 'a AND NOT', '""" (((', '*']) {
      expect(() => kb.search(db, q, 5)).not.toThrow();
    }
  });
});

describe('kb_vec', () => {
  it('upsertVec + knnVec roundtrip returns nearest neighbours in order', () => {
    const db = buildVecDb(2);
    kb.upsertVec(db, 1, Float32Array.from([1, 0]));
    kb.upsertVec(db, 2, Float32Array.from([0, 1]));
    kb.upsertVec(db, 3, Float32Array.from([0.9, 0.1]));

    const hits = kb.knnVec(db, Float32Array.from([1, 0]), 2);
    expect(hits.map((h) => h.note_id)).toEqual([1, 3]);
  });

  it('upsertVec replaces an existing vector', () => {
    const db = buildVecDb(2);
    kb.upsertVec(db, 1, Float32Array.from([1, 0]));
    kb.upsertVec(db, 1, Float32Array.from([0, 1]));

    const hits = kb.knnVec(db, Float32Array.from([0, 1]), 1);
    expect(hits[0].note_id).toBe(1);
    expect(hits[0].distance).toBeCloseTo(0);
  });

  it('notesMissingVec returns only notes without a vector', () => {
    const db = buildVecDb(2);
    const withVec = kb.add(db, { title: 'has vec', body: 'b', tags: '', author: 'a', now: 1 });
    const without = kb.add(db, { title: 'no vec', body: 'b', tags: '', author: 'a', now: 1 });
    kb.upsertVec(db, withVec.id, Float32Array.from([1, 0]));

    expect(kb.notesMissingVec(db, 10).map((n) => n.id)).toEqual([without.id]);
  });
});
