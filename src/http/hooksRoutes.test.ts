// POST /hooks/session-name: the statusline reports what Claude Code's own `/name <x>` sets (or its
// auto-generated conversation title — see CLAUDE.md's "Session names" subsection). Covers storage,
// the graceful-ignore-unknown-session path, and the identity-adoption rules (short label -> rename,
// long sentence -> store only, collision/explicit-identity/kill-switch -> decline adoption).
import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrations.js';
import { buildHooksRoutes } from './hooksRoutes.js';
import { HubBus } from '../core/bus.js';
import * as instancesRepo from '../db/repo/instances.js';
import * as sessionsRepo from '../db/repo/sessions.js';
import type {
  HubConfig,
  IAttachRegistry,
  IClaudeRunner,
  IPromptDelivery,
  Logger,
  RenameBindingSource,
} from '../types.js';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function buildConfig(overrides?: { adoptSessionName?: boolean }): HubConfig {
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
    summaries: { enabled: true, model: 'claude-haiku-4-5' },
    attach: { enabled: true, heartbeatMs: 30_000, redactSecrets: true, fenceCodePastes: false },
    athen: { embeddings: false, model: 'Xenova/all-MiniLM-L6-v2' },
    overlord: { enabled: true, model: 'claude-haiku-4-5', transcriptDays: 30, tailKb: 256 },
    terminalSpawn: {
      enabled: true,
      command: 'wt.exe',
      args: ['-w', '0', 'new-tab', '--title', '{title}', '--startingDirectory', '{cwd}', 'cmd', '/k', '{launcher}', '--name', '{name}'],
      maxPerHour: 6,
      waitForRegisterMs: 60_000,
      readyQuietMs: 1200,
      confirmWorkingMs: 15000,
    },
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
    sessions: { reapIntervalMs: 600000, staleAfterMinutes: 240, adoptSessionName: overrides?.adoptSessionName ?? true },
    logLevel: 'info',
  };
}

function silentLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function fakeDelivery(): IPromptDelivery {
  return { send: vi.fn(), claimForStopBlock: () => undefined };
}

function fakeRunner(): IClaudeRunner {
  return { startNew: vi.fn(), resumePrompt: vi.fn(), isRunning: () => false, runningCwd: () => false, atCapacity: () => false };
}

function fakeAttach(): IAttachRegistry & { rename: ReturnType<typeof vi.fn> } {
  return {
    register: vi.fn(),
    unregister: vi.fn(),
    get: () => undefined,
    inject: vi.fn(() => false),
    touch: vi.fn(),
    count: () => 0,
    ingestOutput: vi.fn(),
    getRingB64: () => undefined,
    listAttached: () => [],
    setWorking: vi.fn(),
    isWorking: () => false,
    rename: vi.fn(),
    stop: vi.fn(),
  };
}

function fakeGateway(): RenameBindingSource & { renameBinding: ReturnType<typeof vi.fn> } {
  return { renameBinding: vi.fn() };
}

function build(db: Database.Database, opts?: { adoptSessionName?: boolean }) {
  const bus = new HubBus();
  const log = silentLogger();
  const attach = fakeAttach();
  const gateway = fakeGateway();
  const config = buildConfig(opts);
  const app = buildHooksRoutes({
    config,
    db,
    bus,
    log,
    delivery: fakeDelivery(),
    getWatcher: () => undefined,
    runner: fakeRunner(),
    attach,
    getGateway: () => gateway,
  });
  return { app, attach, gateway, log };
}

// Seeds an instance + a session bound to it, mirroring how ensureInstanceAndSession sets things up
// for a real hook. Returns the created instance's id.
function seedSession(
  db: Database.Database,
  opts: { sessionId: string; instanceName: string; cwd: string; named?: boolean }
): number {
  const now = Date.now();
  const inst = opts.named
    ? instancesRepo.upsertNamed(db, { name: opts.instanceName, cwd: opts.cwd, now })
    : instancesRepo.upsert(db, { name: opts.instanceName, cwd: opts.cwd, now });
  sessionsRepo.upsertFromHook(db, { sessionId: opts.sessionId, cwd: opts.cwd, transcriptPath: null, instanceId: inst.id, now });
  return inst.id;
}

async function postSessionName(app: ReturnType<typeof build>['app'], body: Record<string, unknown>) {
  return app.request('/session-name', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /hooks/session-name', () => {
  it('stores the session name and returns 204', async () => {
    const db = buildDb();
    seedSession(db, { sessionId: 'sess-1', instanceName: 'proj', cwd: '/proj' });
    const { app } = build(db);

    const res = await postSessionName(app, { session_id: 'sess-1', cwd: '/proj', name: 'Display agent info on console top line' });

    expect(res.status).toBe(204);
    expect(sessionsRepo.get(db, 'sess-1')?.session_name).toBe('Display agent info on console top line');
  });

  it('ignores an unknown session gracefully (204, no throw)', async () => {
    const db = buildDb();
    const { app } = build(db);

    const res = await postSessionName(app, { session_id: 'no-such-session', cwd: '/proj', name: 'wb-sync' });

    expect(res.status).toBe(204);
  });

  it('ignores a missing/empty name (204, nothing stored)', async () => {
    const db = buildDb();
    seedSession(db, { sessionId: 'sess-1', instanceName: 'proj', cwd: '/proj' });
    const { app } = build(db);

    const res = await postSessionName(app, { session_id: 'sess-1', cwd: '/proj', name: '   ' });

    expect(res.status).toBe(204);
    expect(sessionsRepo.get(db, 'sess-1')?.session_name).toBeNull();
  });

  it('adopts a short deliberate name: renames the instance, marks named=1, name_source=session', async () => {
    const db = buildDb();
    const instanceId = seedSession(db, { sessionId: 'sess-1', instanceName: 'proj', cwd: '/proj' });
    const { app, attach, gateway } = build(db);

    const res = await postSessionName(app, { session_id: 'sess-1', cwd: '/proj', name: 'wb-sync' });

    expect(res.status).toBe(204);
    const inst = instancesRepo.byId(db, instanceId);
    expect(inst?.name).toBe('wb-sync');
    expect(inst?.named).toBe(1);
    expect(inst?.name_source).toBe('session');
    expect(attach.rename).toHaveBeenCalledWith('proj', 'wb-sync');
    expect(gateway.renameBinding).toHaveBeenCalledWith('proj', 'wb-sync');
  });

  it('a further short /name re-adopts (name_source stays session, not blocked by a prior adoption)', async () => {
    const db = buildDb();
    const instanceId = seedSession(db, { sessionId: 'sess-1', instanceName: 'proj', cwd: '/proj' });
    const { app } = build(db);

    await postSessionName(app, { session_id: 'sess-1', cwd: '/proj', name: 'wb-sync' });
    const res = await postSessionName(app, { session_id: 'sess-1', cwd: '/proj', name: 'csv export' });

    expect(res.status).toBe(204);
    const inst = instancesRepo.byId(db, instanceId);
    expect(inst?.name).toBe('csv-export');
    expect(inst?.name_source).toBe('session');
  });

  it('does NOT adopt when the instance name was set explicitly (named=1, name_source=explicit)', async () => {
    const db = buildDb();
    const instanceId = seedSession(db, { sessionId: 'sess-1', instanceName: 'wb-sync', cwd: '/proj', named: true });
    const { app, attach } = build(db);

    const res = await postSessionName(app, { session_id: 'sess-1', cwd: '/proj', name: 'other-name' });

    expect(res.status).toBe(204);
    const inst = instancesRepo.byId(db, instanceId);
    expect(inst?.name).toBe('wb-sync');
    expect(inst?.name_source).toBe('explicit');
    expect(attach.rename).not.toHaveBeenCalled();
    // Still stored for display even though adoption was declined.
    expect(sessionsRepo.get(db, 'sess-1')?.session_name).toBe('other-name');
  });

  it('does NOT adopt when the candidate name collides with a DIFFERENT existing instance', async () => {
    const db = buildDb();
    const now = Date.now();
    instancesRepo.upsert(db, { name: 'taken', cwd: '/other', now });
    const instanceId = seedSession(db, { sessionId: 'sess-1', instanceName: 'proj', cwd: '/proj' });
    const { app, attach } = build(db);

    const res = await postSessionName(app, { session_id: 'sess-1', cwd: '/proj', name: 'taken' });

    expect(res.status).toBe(204);
    expect(instancesRepo.byId(db, instanceId)?.name).toBe('proj');
    expect(attach.rename).not.toHaveBeenCalled();
  });

  it('does NOT adopt a long, sentence-like auto-generated title, but still stores it', async () => {
    const db = buildDb();
    const instanceId = seedSession(db, { sessionId: 'sess-1', instanceName: 'proj', cwd: '/proj' });
    const { app, attach } = build(db);

    const res = await postSessionName(app, { session_id: 'sess-1', cwd: '/proj', name: 'Display agent info on console top line' });

    expect(res.status).toBe(204);
    expect(instancesRepo.byId(db, instanceId)?.name).toBe('proj');
    expect(attach.rename).not.toHaveBeenCalled();
    expect(sessionsRepo.get(db, 'sess-1')?.session_name).toBe('Display agent info on console top line');
  });

  it('respects the sessions.adoptSessionName kill-switch: stores the name but never renames', async () => {
    const db = buildDb();
    const instanceId = seedSession(db, { sessionId: 'sess-1', instanceName: 'proj', cwd: '/proj' });
    const { app, attach } = build(db, { adoptSessionName: false });

    const res = await postSessionName(app, { session_id: 'sess-1', cwd: '/proj', name: 'wb-sync' });

    expect(res.status).toBe(204);
    expect(instancesRepo.byId(db, instanceId)?.name).toBe('proj');
    expect(attach.rename).not.toHaveBeenCalled();
    expect(sessionsRepo.get(db, 'sess-1')?.session_name).toBe('wb-sync');
  });

  it('returns 204 on a malformed JSON body instead of erroring', async () => {
    const db = buildDb();
    const { app } = build(db);

    const res = await app.request('/session-name', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });

    expect(res.status).toBe(204);
  });
});
