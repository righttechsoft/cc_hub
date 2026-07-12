import { describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrations.js';
import { buildApiRoutes } from './apiRoutes.js';
import { createAthen } from '../kb/athen.js';
import * as pushTokensRepo from '../db/repo/pushTokens.js';
import type { HubConfig, IClaudeRunner, IPromptDelivery, Logger, RunResult } from '../types.js';
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
    athen: { embeddings: false, model: 'Xenova/all-MiniLM-L6-v2' },
    notifications: { enabled: false, permissionRequests: true, needsInput: true, turnEnd: false, limit: true, chatDelivery: true },
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

function buildApp(runner: IClaudeRunner) {
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
