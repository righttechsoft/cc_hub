// apiRoutes.test.ts exercises buildApiRoutes()'s Hono sub-app directly, which has no auth of its
// own — bearerAuth is layered on top by buildApp() (see app.ts). These tests build the real
// top-level app so the /admin fragment routes' auth wiring is actually verified end-to-end,
// instead of just assumed from apiRoutes.ts being mounted under /api/*.
import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { runMigrations } from '../db/migrations.js';
import { buildApp } from './app.js';
import { buildApiRoutes } from './apiRoutes.js';
import { createAthen } from '../kb/athen.js';
import { HubBus } from '../core/bus.js';
import { AttachRegistry } from '../attach/attachRegistry.js';
import type { HubConfig, IClaudeRunner, IPromptDelivery, Logger } from '../types.js';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function silentLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
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
    chatDelivery: { enabled: true, tickMs: 30_000, maxSpawnsPerInstancePerHour: 4 },
    attach: { enabled: false, heartbeatMs: 30_000, redactSecrets: true, fenceCodePastes: false },
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

function fakeRunner(): IClaudeRunner {
  return {
    startNew: vi.fn(),
    resumePrompt: vi.fn(),
    isRunning: () => false,
    runningCwd: () => false,
    atCapacity: () => false,
  };
}

function fakeDelivery(): IPromptDelivery {
  return { send: vi.fn(), claimForStopBlock: () => undefined };
}

function buildFullApp() {
  const config = buildConfig();
  const db = buildDb();
  const bus = new HubBus();
  const log = silentLogger();
  const attach = new AttachRegistry({ log, bus }, config.attach.heartbeatMs);
  const athen = createAthen({ db, log, embedder: undefined });
  const apiRoutes = buildApiRoutes({
    config,
    db,
    bus,
    log,
    delivery: fakeDelivery(),
    watcher: undefined,
    runner: fakeRunner(),
    athen,
    startedAt: Date.now(),
    attach,
  });

  const { app } = buildApp({
    config,
    db,
    bus,
    log,
    gateway: { handle: async () => new Response('not implemented', { status: 501 }) },
    delivery: fakeDelivery(),
    watcher: undefined,
    attach,
    hooksRoutes: new Hono(),
    apiRoutes,
  });

  return { app, config, db };
}

describe('bearer auth wiring for admin fragment routes', () => {
  it('401s GET /api/v1/admin/kb-list without a bearer token', async () => {
    const { app } = buildFullApp();

    const res = await app.request('/api/v1/admin/kb-list');

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
  });

  it('200s GET /api/v1/admin/kb-list with the correct bearer token', async () => {
    const { app, config } = buildFullApp();

    const res = await app.request('/api/v1/admin/kb-list', {
      headers: { Authorization: `Bearer ${config.authToken}` },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
  });

  it('401s DELETE /api/v1/admin/messages/:id without a bearer token', async () => {
    const { app } = buildFullApp();

    const res = await app.request('/api/v1/admin/messages/1', { method: 'DELETE' });

    expect(res.status).toBe(401);
  });

  it('GET /admin serves the static page without requiring a bearer token', async () => {
    const { app } = buildFullApp();

    const res = await app.request('/admin');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('cc_hub admin');
  });
});
