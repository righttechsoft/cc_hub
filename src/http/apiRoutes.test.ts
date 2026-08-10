import { describe, expect, it, vi, afterAll, beforeAll } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrations.js';
import { buildApiRoutes } from './apiRoutes.js';
import { createAthen } from '../kb/athen.js';
import * as pushTokensRepo from '../db/repo/pushTokens.js';
import type { AttachedClient, HubConfig, IAttachRegistry, IClaudeRunner, IPromptDelivery, Logger, RunResult } from '../types.js';
import { HubBus } from '../core/bus.js';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function buildConfig(): HubConfig {
  return {
    port: 4270,
    bindAddress: '127.0.0.1',
    authToken: 'test-token',
    claudePath: 'claude.exe',
    hooks: { postToolUse: false, postToolUseThrottleMs: 2000, permissionWaitMs: 30000 },
    limitWatcher: {
      enabled: false,
      pollIntervalMs: 3_600_000,
      retryIntervalMs: 3_600_000,
      limitedThresholdPct: 95,
      resetJitterMs: 90_000,
    },
    autoContinue: {
      enabled: true,
      prompt: 'continue where you left off',
      maxPerSessionPerDay: 3,
      maxConcurrent: 1,
      eligibleWindowMinutes: 10,
      transcriptScanWindowMinutes: 360,
      permissionMode: 'default',
    },
    retention: { sessionEventsDays: 14, messagesDays: 90 },
    relay: { enabled: false, url: '', secret: '' },
    chatDelivery: {
      enabled: true,
      tickMs: 30_000,
      maxSpawnsPerInstancePerHour: 4,
    },
    attach: { enabled: true, heartbeatMs: 30_000, redactSecrets: true, fenceCodePastes: false },
    athen: { embeddings: false, model: 'Xenova/all-MiniLM-L6-v2' },
    notifications: {
      enabled: false,
      permissionRequests: true,
      needsInput: true,
      turnEnd: false,
      limit: true,
      chatDelivery: true,
      aiIdleFilter: false,
      aiIdleFilterModel: 'claude-haiku-4-5',
      outputTriggers: true,
    },
    push: {
      enabled: false,
      awayThresholdMinutes: 3,
      apns: { keyPath: '', keyId: '', teamId: '', bundleId: 'com.righttechsoft.ccHubMobile', environment: 'production' },
    },
    logLevel: 'info',
  };
}

function silentLogger(): Logger & { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> } {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function fakeDelivery(): IPromptDelivery {
  return {
    send: vi.fn(),
    claimForStopBlock: () => undefined,
  };
}

function fakeRunResult(): RunResult {
  return { code: 0, stdout: '', stderr: '', startedAt: 0, endedAt: 0 };
}

function fakeRunner(opts?: { atCapacity?: boolean }): IClaudeRunner & { startNew: ReturnType<typeof vi.fn> } {
  return {
    startNew: vi.fn().mockResolvedValue(fakeRunResult()),
    resumePrompt: vi.fn(),
    isRunning: () => false,
    runningCwd: () => false,
    atCapacity: vi.fn().mockReturnValue(opts?.atCapacity ?? false),
  };
}

function fakeAttach(opts?: { attachedCwd?: string }): IAttachRegistry & { inject: ReturnType<typeof vi.fn> } {
  const attachedCwd = opts?.attachedCwd;
  return {
    register: vi.fn(),
    unregister: vi.fn(),
    get: (cwd: string) => (cwd === attachedCwd ? ({ ws: {}, pid: 1, lastSeen: Date.now() } as unknown as AttachedClient) : undefined),
    inject: vi.fn().mockReturnValue(true),
    touch: vi.fn(),
    count: () => (attachedCwd ? 1 : 0),
    ingestOutput: vi.fn(),
    getRingB64: () => undefined,
    listAttached: () => (attachedCwd ? [attachedCwd] : []),
    setWorking: vi.fn(),
    isWorking: () => false,
    stop: vi.fn(),
  };
}

function insertSession(db: Database.Database, id: string, transcriptPath: string | null): void {
  const now = Date.now();
  const info = db
    .prepare('INSERT INTO instances (name, cwd, alias, first_seen_at, last_seen_at) VALUES (?, ?, NULL, ?, ?)')
    .run(`inst-${id}`, `/proj-${id}`, now, now);
  db.prepare(
    `INSERT INTO sessions
      (id, instance_id, cwd, transcript_path, status, started_at, last_event_at, auto_continue, continues_today, continues_date)
     VALUES (?, ?, '/proj', ?, 'idle', ?, ?, 1, 0, NULL)`
  ).run(id, Number(info.lastInsertRowid), transcriptPath, now, now);
}

function buildApp(runner: IClaudeRunner, attach?: IAttachRegistry) {
  const db = buildDb();
  const bus = new HubBus();
  const log = silentLogger();
  const delivery = fakeDelivery();
  const app = buildApiRoutes({
    config: buildConfig(),
    db,
    bus,
    log,
    delivery,
    watcher: undefined,
    runner,
    athen: createAthen({ db, log, embedder: undefined }),
    startedAt: Date.now(),
    attach: attach ?? fakeAttach(),
  });
  return { app, db, log };
}

describe('POST /sessions', () => {
  it('400s when cwd is missing', async () => {
    const runner = fakeRunner();
    const { app } = buildApp(runner);

    const res = await app.request('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad_request');
    expect(runner.startNew).not.toHaveBeenCalled();
  });

  it('400s when prompt is missing', async () => {
    const runner = fakeRunner();
    const { app } = buildApp(runner);

    const res = await app.request('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: tmpdir() }),
    });

    expect(res.status).toBe(400);
    expect(runner.startNew).not.toHaveBeenCalled();
  });

  it('400s when cwd is relative', async () => {
    const runner = fakeRunner();
    const { app } = buildApp(runner);

    const res = await app.request('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: 'relative/path', prompt: 'hello' }),
    });

    expect(res.status).toBe(400);
    expect(runner.startNew).not.toHaveBeenCalled();
  });

  it('400s when cwd does not exist', async () => {
    const runner = fakeRunner();
    const { app } = buildApp(runner);

    const missingDir = join(tmpdir(), 'cc_hub-test-does-not-exist-12345');
    const res = await app.request('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: missingDir, prompt: 'hello' }),
    });

    expect(res.status).toBe(400);
    expect(runner.startNew).not.toHaveBeenCalled();
  });

  it('400s when prompt exceeds max length', async () => {
    const runner = fakeRunner();
    const { app } = buildApp(runner);

    const res = await app.request('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: tmpdir(), prompt: 'x'.repeat(8001) }),
    });

    expect(res.status).toBe(400);
    expect(runner.startNew).not.toHaveBeenCalled();
  });

  it('400s when permissionMode is invalid', async () => {
    const runner = fakeRunner();
    const { app } = buildApp(runner);

    const res = await app.request('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: tmpdir(), prompt: 'hello', permissionMode: 'not-a-real-mode' }),
    });

    expect(res.status).toBe(400);
    expect(runner.startNew).not.toHaveBeenCalled();
  });

  it('409s when the runner is at capacity', async () => {
    const runner = fakeRunner({ atCapacity: true });
    const { app } = buildApp(runner);

    const res = await app.request('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: tmpdir(), prompt: 'hello' }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('conflict');
    expect(body.error.message).toMatch(/max concurrent/);
    expect(runner.startNew).not.toHaveBeenCalled();
  });

  it('202s on the happy path and fires startNew fire-and-forget with the right args', async () => {
    const runner = fakeRunner();
    const { app } = buildApp(runner);
    const cwd = tmpdir();

    const res = await app.request('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd, prompt: 'hello there' }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as { spawned: boolean };
    expect(body).toEqual({ spawned: true });
    expect(runner.startNew).toHaveBeenCalledTimes(1);
    expect(runner.startNew).toHaveBeenCalledWith({ cwd, prompt: 'hello there', permissionMode: undefined });
  });
});

describe('KB (Athen) CRUD', () => {
  it('GET /kb lists recent notes newest first', async () => {
    const runner = fakeRunner();
    const { app } = buildApp(runner);

    await app.request('/kb', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'first', body: 'b1' }),
    });
    const secondRes = await app.request('/kb', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'second', body: 'b2' }),
    });
    const second = (await secondRes.json()) as { note: { id: number } };

    const res = await app.request('/kb');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notes: { id: number; title: string }[] };
    expect(body.notes[0]).toEqual(expect.objectContaining({ id: second.note.id, title: 'second' }));
  });

  it('PUT /kb/:id updates and merges fields, reflected in GET /kb/:id', async () => {
    const runner = fakeRunner();
    const { app } = buildApp(runner);

    const createRes = await app.request('/kb', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'orig title', body: 'orig body', tags: 'x' }),
    });
    const created = (await createRes.json()) as { note: { id: number } };

    const updateRes = await app.request(`/kb/${created.note.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'new title' }),
    });
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as { note: { title: string; body: string; tags: string } };
    expect(updated.note.title).toBe('new title');
    expect(updated.note.body).toBe('orig body'); // untouched field preserved
    expect(updated.note.tags).toBe('x');

    const getRes = await app.request(`/kb/${created.note.id}`);
    const fetched = (await getRes.json()) as { note: { title: string } };
    expect(fetched.note.title).toBe('new title');
  });

  it('PUT /kb/:id 404s for a missing note', async () => {
    const runner = fakeRunner();
    const { app } = buildApp(runner);

    const res = await app.request('/kb/999999', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('PUT /kb/:id 400s when no fields are given', async () => {
    const runner = fakeRunner();
    const { app } = buildApp(runner);
    const createRes = await app.request('/kb', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 't', body: 'b' }),
    });
    const created = (await createRes.json()) as { note: { id: number } };

    const res = await app.request(`/kb/${created.note.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it('DELETE /kb/:id deletes an existing note', async () => {
    const runner = fakeRunner();
    const { app } = buildApp(runner);
    const createRes = await app.request('/kb', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 't', body: 'b' }),
    });
    const created = (await createRes.json()) as { note: { id: number } };

    const delRes = await app.request(`/kb/${created.note.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toEqual({ deleted: true });

    const getRes = await app.request(`/kb/${created.note.id}`);
    expect(getRes.status).toBe(404);
  });

  it('DELETE /kb/:id 404s for a missing note', async () => {
    const runner = fakeRunner();
    const { app } = buildApp(runner);

    const res = await app.request('/kb/999999', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /messages/:id', () => {
  it('deletes an existing message, removed from listAll', async () => {
    const runner = fakeRunner();
    const { app } = buildApp(runner);

    const sendRes = await app.request('/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'hello everyone' }),
    });
    const sent = (await sendRes.json()) as { message: { id: number } };

    const delRes = await app.request(`/messages/${sent.message.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toEqual({ deleted: true });

    const listRes = await app.request('/messages');
    const list = (await listRes.json()) as { messages: { id: number }[] };
    expect(list.messages.find((m) => m.id === sent.message.id)).toBeUndefined();
  });

  it('404s for a missing message', async () => {
    const runner = fakeRunner();
    const { app } = buildApp(runner);

    const res = await app.request('/messages/999999', { method: 'DELETE' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });
});

function formBody(fields: Record<string, string>): { headers: Record<string, string>; body: string } {
  return {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  };
}

describe('Admin fragment routes (htmx)', () => {
  it('GET /admin/kb-list renders note cards, escaping hostile titles', async () => {
    const runner = fakeRunner();
    const { app } = buildApp(runner);
    await app.request('/kb', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '<script>alert(1)</script>', body: 'b' }),
    });

    const res = await app.request('/admin/kb-list');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('GET /admin/kb-search falls back to recent notes for an empty query', async () => {
    const runner = fakeRunner();
    const { app } = buildApp(runner);
    await app.request('/kb', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'a note', body: 'b' }),
    });

    const res = await app.request('/admin/kb-search?q=');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('a note');
  });

  it('GET /admin/kb-new renders a blank create form', async () => {
    const runner = fakeRunner();
    const { app } = buildApp(runner);

    const res = await app.request('/admin/kb-new');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('hx-post="/api/v1/admin/kb"');
  });

  it('GET /admin/kb-edit/:id renders the note, 404s when missing', async () => {
    const runner = fakeRunner();
    const { app } = buildApp(runner);
    const createRes = await app.request('/kb', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'edit me', body: 'body here' }),
    });
    const created = (await createRes.json()) as { note: { id: number } };

    const okRes = await app.request(`/admin/kb-edit/${created.note.id}`);
    expect(okRes.status).toBe(200);
    expect(await okRes.text()).toContain('edit me');

    const missingRes = await app.request('/admin/kb-edit/999999');
    expect(missingRes.status).toBe(404);
    expect(await missingRes.text()).toContain('Note not found');
  });

  it('POST /admin/kb creates a note from form data and triggers a list refresh', async () => {
    const runner = fakeRunner();
    const { app, db } = buildApp(runner);

    const res = await app.request('/admin/kb', {
      method: 'POST',
      ...formBody({ title: 'from form', tags: 't', body: 'body text' }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('HX-Trigger')).toBe('kb-changed');
    const html = await res.text();
    expect(html).toContain('from form');
    const count = db.prepare('SELECT COUNT(*) AS n FROM kb_notes').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('POST /admin/kb 400s and redisplays entered values when title/body are missing', async () => {
    const runner = fakeRunner();
    const { app } = buildApp(runner);

    const res = await app.request('/admin/kb', {
      method: 'POST',
      ...formBody({ title: '', tags: '', body: '' }),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain('required');
  });

  it('PUT /admin/kb/:id updates the note and triggers a list refresh; 404s when missing', async () => {
    const runner = fakeRunner();
    const { app } = buildApp(runner);
    const createRes = await app.request('/kb', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'orig', body: 'orig body', tags: '' }),
    });
    const created = (await createRes.json()) as { note: { id: number } };

    const res = await app.request(`/admin/kb/${created.note.id}`, {
      method: 'PUT',
      ...formBody({ title: 'updated title', tags: '', body: 'orig body' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('HX-Trigger')).toBe('kb-changed');
    expect(await res.text()).toContain('updated title');

    const missingRes = await app.request('/admin/kb/999999', {
      method: 'PUT',
      ...formBody({ title: 'x', tags: '', body: 'y' }),
    });
    expect(missingRes.status).toBe(404);
  });

  it('DELETE /admin/kb/:id deletes the note (list renders fewer notes after); 404s when missing', async () => {
    const runner = fakeRunner();
    const { app } = buildApp(runner);
    const createRes = await app.request('/kb', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'to delete', body: 'b' }),
    });
    const created = (await createRes.json()) as { note: { id: number } };

    const delRes = await app.request(`/admin/kb/${created.note.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    expect(delRes.headers.get('HX-Trigger')).toBe('kb-changed');

    const listRes = await app.request('/admin/kb-list');
    expect(await listRes.text()).not.toContain('to delete');

    const missingRes = await app.request('/admin/kb/999999', { method: 'DELETE' });
    expect(missingRes.status).toBe(404);
  });

  it('GET /admin/messages-list renders messages, escaping a hostile body', async () => {
    const runner = fakeRunner();
    const { app } = buildApp(runner);
    await app.request('/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: '<script>alert(1)</script>' }),
    });

    const res = await app.request('/admin/messages-list');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('DELETE /admin/messages/:id removes the message; 404s when missing', async () => {
    const runner = fakeRunner();
    const { app } = buildApp(runner);
    const sendRes = await app.request('/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'delete me via fragment route' }),
    });
    const sent = (await sendRes.json()) as { message: { id: number } };

    const delRes = await app.request(`/admin/messages/${sent.message.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    expect(await delRes.text()).toBe('');

    const listRes = await app.request('/messages');
    const list = (await listRes.json()) as { messages: { id: number }[] };
    expect(list.messages.find((m) => m.id === sent.message.id)).toBeUndefined();

    const missingRes = await app.request(`/admin/messages/${sent.message.id}`, { method: 'DELETE' });
    expect(missingRes.status).toBe(404);
  });
});

describe('POST /push/register', () => {
  it('200s and stores a valid hex device token', async () => {
    const runner = fakeRunner();
    const { app, db } = buildApp(runner);

    const res = await app.request('/push/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'AABBCCDD00112233' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body).toEqual({ ok: true });
    expect(pushTokensRepo.list(db).map((r) => r.token)).toEqual(['aabbccdd00112233']);
  });

  it('400s for a non-hex token', async () => {
    const runner = fakeRunner();
    const { app } = buildApp(runner);

    const res = await app.request('/push/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'not-a-hex-token!!' }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('bad_request');
  });
});

describe('GET /sessions/:id/transcript', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-hub-apiroutes-transcript-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('404s for an unknown session', async () => {
    const runner = fakeRunner();
    const { app } = buildApp(runner);

    const res = await app.request('/sessions/does-not-exist/transcript');

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('409s when the session has no transcript_path', async () => {
    const runner = fakeRunner();
    const { app, db } = buildApp(runner);
    insertSession(db, 'sess-no-transcript', null);

    const res = await app.request('/sessions/sess-no-transcript/transcript');

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('no_transcript');
  });

  it('409s when the transcript file cannot be read', async () => {
    const runner = fakeRunner();
    const { app, db } = buildApp(runner);
    insertSession(db, 'sess-missing-file', join(dir, 'does-not-exist.jsonl'));

    const res = await app.request('/sessions/sess-missing-file/transcript');

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('no_transcript');
  });

  it('200s on the happy path with parsed entries', async () => {
    const runner = fakeRunner();
    const { app, db } = buildApp(runner);
    const transcriptPath = join(dir, 'happy.jsonl');
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ uuid: 'u1', type: 'user', timestamp: '2024-01-01T00:00:00.000Z', message: { content: 'hello' } }),
        JSON.stringify({
          uuid: 'a1',
          type: 'assistant',
          timestamp: '2024-01-01T00:00:01.000Z',
          message: { content: [{ type: 'text', text: 'hi there' }] },
        }),
      ].join('\n') + '\n',
      'utf8'
    );
    insertSession(db, 'sess-happy', transcriptPath);

    const res = await app.request('/sessions/sess-happy/transcript');

    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[]; byteOffset: number; truncatedHead: boolean };
    expect(body.entries).toHaveLength(2);
    expect(body.truncatedHead).toBe(false);
    expect(typeof body.byteOffset).toBe('number');
  });

  it('afterByte round-trips: a second call with the previous byteOffset returns only newly appended entries', async () => {
    const runner = fakeRunner();
    const { app, db } = buildApp(runner);
    const transcriptPath = join(dir, 'roundtrip.jsonl');
    writeFileSync(
      transcriptPath,
      JSON.stringify({ uuid: 'r1', type: 'user', message: { content: 'first' } }) + '\n',
      'utf8'
    );
    insertSession(db, 'sess-roundtrip', transcriptPath);

    const firstRes = await app.request('/sessions/sess-roundtrip/transcript');
    const first = (await firstRes.json()) as { entries: { uuid: string }[]; byteOffset: number };
    expect(first.entries.map((e) => e.uuid)).toEqual(['r1']);

    writeFileSync(
      transcriptPath,
      JSON.stringify({ uuid: 'r1', type: 'user', message: { content: 'first' } }) +
        '\n' +
        JSON.stringify({ uuid: 'r2', type: 'user', message: { content: 'second' } }) +
        '\n',
      'utf8'
    );

    const secondRes = await app.request(`/sessions/sess-roundtrip/transcript?afterByte=${first.byteOffset}`);
    expect(secondRes.status).toBe(200);
    const second = (await secondRes.json()) as { entries: { uuid: string }[]; byteOffset: number };
    expect(second.entries.map((e) => e.uuid)).toEqual(['r2']);
  });
});

describe('POST /sessions/:id/image', () => {
  const tinyPngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

  it('404s for an unknown session', async () => {
    const runner = fakeRunner();
    const { app } = buildApp(runner);

    const res = await app.request('/sessions/does-not-exist/image', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageBase64: tinyPngBase64 }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
  });

  it('200s and returns a saved file path without requiring an attached wrapper', async () => {
    const runner = fakeRunner();
    const attach = fakeAttach(); // no cwd attached — should not matter anymore
    const { app, db } = buildApp(runner, attach);
    insertSession(db, 'sess-not-attached', null);

    const res = await app.request('/sessions/sess-not-attached/image', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageBase64: tinyPngBase64 }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string };
    expect(body.path).toMatch(/ccimg_[0-9a-f]+\.png$/);
    expect(attach.inject).not.toHaveBeenCalled();
  });

  it('200s with the requested extension and does not inject', async () => {
    const runner = fakeRunner();
    const attach = fakeAttach({ attachedCwd: '/proj' }); // insertSession hardcodes cwd '/proj'
    const { app, db } = buildApp(runner, attach);
    insertSession(db, 'sess-attached', null);

    const res = await app.request('/sessions/sess-attached/image', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageBase64: tinyPngBase64, ext: 'png' }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string };
    expect(body.path).toMatch(/ccimg_[0-9a-f]+\.png$/);
    expect(body.path.startsWith(tmpdir())).toBe(true);

    expect(attach.inject).not.toHaveBeenCalled();
  });

  it('413s when the decoded image exceeds the size cap', async () => {
    const runner = fakeRunner();
    const attach = fakeAttach({ attachedCwd: '/proj' });
    const { app, db } = buildApp(runner, attach);
    insertSession(db, 'sess-too-large', null);

    // ~5.4MB of base64 decodes to just over the 4MB cap.
    const oversizedBase64 = Buffer.alloc(4 * 1024 * 1024 + 1, 1).toString('base64');

    const res = await app.request('/sessions/sess-too-large/image', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ imageBase64: oversizedBase64 }),
    });

    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('too_large');
    expect(attach.inject).not.toHaveBeenCalled();
  });
});
