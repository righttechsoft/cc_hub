import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrations.js';
import * as instancesRepo from './instances.js';
import * as instanceAppsRepo from './instanceApps.js';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

describe('instanceApps repo', () => {
  it('replaceAll clears the previous list and inserts the new one', () => {
    const db = buildDb();
    const now = Date.now();
    const alpha = instancesRepo.upsert(db, { name: 'alpha', cwd: '/alpha', now });

    instanceAppsRepo.replaceAll(db, alpha.id, [{ label: 'localhost:3000', url: 'http://localhost:3000' }], now);
    expect(instanceAppsRepo.listForInstance(db, alpha.id)).toHaveLength(1);

    instanceAppsRepo.replaceAll(
      db,
      alpha.id,
      [
        { label: 'localhost:4000', url: 'http://localhost:4000' },
        { label: 'desktop app' },
      ],
      now + 1000
    );

    const rows = instanceAppsRepo.listForInstance(db, alpha.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.label).sort()).toEqual(['desktop app', 'localhost:4000']);
    expect(rows.find((r) => r.label === 'desktop app')?.url).toBeNull();
  });

  it('replaceAll with an empty array clears the list', () => {
    const db = buildDb();
    const now = Date.now();
    const alpha = instancesRepo.upsert(db, { name: 'alpha', cwd: '/alpha', now });
    instanceAppsRepo.replaceAll(db, alpha.id, [{ label: 'x', url: 'http://x' }], now);

    instanceAppsRepo.replaceAll(db, alpha.id, [], now + 1000);
    expect(instanceAppsRepo.listForInstance(db, alpha.id)).toEqual([]);
  });

  it('upsert inserts a new label and updates an existing one in place', () => {
    const db = buildDb();
    const now = Date.now();
    const alpha = instancesRepo.upsert(db, { name: 'alpha', cwd: '/alpha', now });

    instanceAppsRepo.upsert(db, alpha.id, 'localhost:5173', 'http://localhost:5173', now);
    instanceAppsRepo.upsert(db, alpha.id, 'localhost:5173', 'http://localhost:5174', now + 1000);

    const rows = instanceAppsRepo.listForInstance(db, alpha.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].url).toBe('http://localhost:5174');
    expect(rows[0].updated_at).toBe(now + 1000);
  });

  it('listAllJoined joins the owning instance name, most recently updated first', () => {
    const db = buildDb();
    const now = Date.now();
    const alpha = instancesRepo.upsert(db, { name: 'alpha', cwd: '/alpha', now });
    const beta = instancesRepo.upsert(db, { name: 'beta', cwd: '/beta', now });

    instanceAppsRepo.upsert(db, alpha.id, 'a-app', 'http://a', now);
    instanceAppsRepo.upsert(db, beta.id, 'b-app', 'http://b', now + 1000);

    const rows = instanceAppsRepo.listAllJoined(db);
    expect(rows.map((r) => r.instance_name)).toEqual(['beta', 'alpha']);
    expect(rows[0].label).toBe('b-app');
  });
});
