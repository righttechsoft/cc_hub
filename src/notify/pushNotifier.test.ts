import { describe, expect, it, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrations.js';
import { HubBus } from '../core/bus.js';
import * as instancesRepo from '../db/repo/instances.js';
import * as sessionsRepo from '../db/repo/sessions.js';
import * as pushTokensRepo from '../db/repo/pushTokens.js';
import { startPushNotifier } from './pushNotifier.js';
import type { HubConfig, LimitStateRow, Logger, PermissionRow } from '../types.js';
import type { ApnsSendResult } from './apns.js';

const shouldNotifyIdlePromptMock = vi.fn<(...args: unknown[]) => Promise<boolean>>();
vi.mock('./needsInputFilter.js', () => ({
  shouldNotifyIdlePrompt: (...args: unknown[]) => shouldNotifyIdlePromptMock(...args),
}));

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function buildConfig(opts?: Partial<HubConfig['notifications']>): HubConfig {
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
    athen: { embeddings: false, model: 'Xenova/all-MiniLM-L6-v2' },
    notifications: {
      enabled: true,
      permissionRequests: true,
      needsInput: true,
      turnEnd: false,
      limit: true,
      chatDelivery: true,
      aiIdleFilter: false,
      aiIdleFilterModel: 'claude-haiku-4-5',
      ...opts,
    },
    push: {
      enabled: true,
      awayThresholdMinutes: 3,
      apns: { keyPath: '', keyId: '', teamId: '', bundleId: 'com.righttechsoft.ccHubMobile', environment: 'production' },
    },
    logLevel: 'info',
  };
}

function silentLogger(): Logger & { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> } {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function insertSession(db: Database.Database, instanceName: string, sessionId: string): void {
  const instanceId = instancesRepo.upsert(db, { name: instanceName, cwd: `/proj-${instanceName}`, now: Date.now() }).id;
  sessionsRepo.upsertFromHook(db, {
    sessionId,
    cwd: `/proj-${instanceName}`,
    transcriptPath: null,
    instanceId,
    now: Date.now(),
  });
}

function fakePermission(overrides?: Partial<PermissionRow>): PermissionRow {
  return {
    id: 1,
    session_id: 'sess-1',
    tool_name: 'Bash',
    tool_input: '{"command":"ls -la"}',
    raw: null,
    status: 'pending',
    decided_by: null,
    decision_message: null,
    created_at: Date.now(),
    decided_at: null,
    ...overrides,
  };
}

function fakeLimitState(state: LimitStateRow['state']): LimitStateRow {
  return {
    id: 1,
    state,
    utilization: 96,
    resets_at: null,
    last_poll_at: Date.now(),
    last_ok_poll_at: null,
    error: null,
  };
}

function fakeAway(away: boolean) {
  return { isAway: () => away };
}

function fakeSender(result: ApnsSendResult = 'ok') {
  return { send: vi.fn(async (_token: string, _title: string, _message: string | undefined) => result) };
}

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe('startPushNotifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends a push to every registered token on permission_request while away', async () => {
    const db = buildDb();
    insertSession(db, 'proj', 'sess-1');
    pushTokensRepo.upsert(db, { token: 'aaaa1111', platform: 'ios', now: Date.now() });
    pushTokensRepo.upsert(db, { token: 'bbbb2222', platform: 'ios', now: Date.now() });
    const bus = new HubBus();
    const sender = fakeSender();
    const pn = startPushNotifier({ db, bus, config: buildConfig(), log: silentLogger(), away: fakeAway(true), sender });

    bus.emit({ type: 'permission_request', request: fakePermission() });
    await tick();

    expect(sender.send).toHaveBeenCalledTimes(2);
    const [token, title, message] = sender.send.mock.calls[0] as [string, string, string | undefined];
    expect(['aaaa1111', 'bbbb2222']).toContain(token);
    expect(title).toBe('proj — permission');
    expect(message).toContain('Bash');

    pn.stop();
  });

  it('sends nothing when the user is not away', async () => {
    const db = buildDb();
    insertSession(db, 'proj', 'sess-1');
    pushTokensRepo.upsert(db, { token: 'aaaa1111', platform: 'ios', now: Date.now() });
    const bus = new HubBus();
    const sender = fakeSender();
    const pn = startPushNotifier({ db, bus, config: buildConfig(), log: silentLogger(), away: fakeAway(false), sender });

    bus.emit({ type: 'permission_request', request: fakePermission() });
    await tick();

    expect(sender.send).not.toHaveBeenCalled();
    pn.stop();
  });

  it('removes a token when the sender reports it as unregistered', async () => {
    const db = buildDb();
    insertSession(db, 'proj', 'sess-1');
    pushTokensRepo.upsert(db, { token: 'aaaa1111', platform: 'ios', now: Date.now() });
    const bus = new HubBus();
    const sender = fakeSender('unregistered');
    const pn = startPushNotifier({ db, bus, config: buildConfig(), log: silentLogger(), away: fakeAway(true), sender });

    bus.emit({ type: 'permission_request', request: fakePermission() });
    await tick();

    expect(pushTokensRepo.list(db)).toHaveLength(0);
    pn.stop();
  });

  it('sends nothing when notifications.permissionRequests is off', async () => {
    const db = buildDb();
    insertSession(db, 'proj', 'sess-1');
    pushTokensRepo.upsert(db, { token: 'aaaa1111', platform: 'ios', now: Date.now() });
    const bus = new HubBus();
    const sender = fakeSender();
    const pn = startPushNotifier({
      db,
      bus,
      config: buildConfig({ permissionRequests: false }),
      log: silentLogger(),
      away: fakeAway(true),
      sender,
    });

    bus.emit({ type: 'permission_request', request: fakePermission() });
    await tick();

    expect(sender.send).not.toHaveBeenCalled();
    pn.stop();
  });

  it('suppresses an idle_prompt Notification while the session is still active', async () => {
    const db = buildDb();
    insertSession(db, 'proj', 'sess-1'); // upsertFromHook inserts status 'active'
    pushTokensRepo.upsert(db, { token: 'aaaa1111', platform: 'ios', now: Date.now() });
    const bus = new HubBus();
    const sender = fakeSender();
    const pn = startPushNotifier({ db, bus, config: buildConfig(), log: silentLogger(), away: fakeAway(true), sender });

    bus.emit({
      type: 'session_event',
      sessionId: 'sess-1',
      eventType: 'Notification',
      payload: { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' },
      createdAt: Date.now(),
    });
    await tick();

    expect(sender.send).not.toHaveBeenCalled();
    pn.stop();
  });

  it('suppresses an idle idle_prompt when aiIdleFilter is on and the filter resolves false', async () => {
    const db = buildDb();
    insertSession(db, 'proj', 'sess-1');
    sessionsRepo.setStatus(db, 'sess-1', 'idle', Date.now());
    pushTokensRepo.upsert(db, { token: 'aaaa1111', platform: 'ios', now: Date.now() });
    shouldNotifyIdlePromptMock.mockResolvedValue(false);
    const bus = new HubBus();
    const sender = fakeSender();
    const pn = startPushNotifier({
      db,
      bus,
      config: buildConfig({ aiIdleFilter: true }),
      log: silentLogger(),
      away: fakeAway(true),
      sender,
    });

    bus.emit({
      type: 'session_event',
      sessionId: 'sess-1',
      eventType: 'Notification',
      payload: { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' },
      createdAt: Date.now(),
    });
    await tick();

    expect(shouldNotifyIdlePromptMock).toHaveBeenCalledTimes(1);
    expect(sender.send).not.toHaveBeenCalled();
    pn.stop();
  });

  it('pushes an idle idle_prompt when aiIdleFilter is on and the filter resolves true', async () => {
    const db = buildDb();
    insertSession(db, 'proj', 'sess-1');
    sessionsRepo.setStatus(db, 'sess-1', 'idle', Date.now());
    pushTokensRepo.upsert(db, { token: 'aaaa1111', platform: 'ios', now: Date.now() });
    shouldNotifyIdlePromptMock.mockResolvedValue(true);
    const bus = new HubBus();
    const sender = fakeSender();
    const pn = startPushNotifier({
      db,
      bus,
      config: buildConfig({ aiIdleFilter: true }),
      log: silentLogger(),
      away: fakeAway(true),
      sender,
    });

    bus.emit({
      type: 'session_event',
      sessionId: 'sess-1',
      eventType: 'Notification',
      payload: { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' },
      createdAt: Date.now(),
    });
    await tick();

    expect(sender.send).toHaveBeenCalledTimes(1);
    const [, title] = sender.send.mock.calls[0] as [string, string, string | undefined];
    expect(title).toBe('proj needs input');
    pn.stop();
  });

  it('pushes exactly two messages across a limited -> ok episode', async () => {
    const db = buildDb();
    pushTokensRepo.upsert(db, { token: 'aaaa1111', platform: 'ios', now: Date.now() });
    const bus = new HubBus();
    const sender = fakeSender();
    const pn = startPushNotifier({ db, bus, config: buildConfig(), log: silentLogger(), away: fakeAway(true), sender });

    bus.emit({ type: 'limit_state', state: fakeLimitState('limited') });
    await tick();
    bus.emit({ type: 'limit_state', state: fakeLimitState('limited') });
    await tick();
    bus.emit({ type: 'limit_state', state: fakeLimitState('ok') });
    await tick();

    expect(sender.send).toHaveBeenCalledTimes(2);
    pn.stop();
  });

  it('pushes on chat_delivery while away when the toggle is on', async () => {
    const db = buildDb();
    pushTokensRepo.upsert(db, { token: 'aaaa1111', platform: 'ios', now: Date.now() });
    const bus = new HubBus();
    const sender = fakeSender();
    const pn = startPushNotifier({ db, bus, config: buildConfig(), log: silentLogger(), away: fakeAway(true), sender });

    bus.emit({ type: 'chat_delivery', instance: 'proj', fromNames: ['other'], count: 2, createdAt: Date.now() });
    await tick();

    expect(sender.send).toHaveBeenCalledTimes(1);
    const [, title, message] = sender.send.mock.calls[0] as [string, string, string | undefined];
    expect(title).toBe('proj — incoming chat');
    expect(message).toContain('2 messages');
    expect(message).toContain('other');

    pn.stop();
  });

  it('does not push on chat_delivery when notifications.chatDelivery is off', async () => {
    const db = buildDb();
    pushTokensRepo.upsert(db, { token: 'aaaa1111', platform: 'ios', now: Date.now() });
    const bus = new HubBus();
    const sender = fakeSender();
    const pn = startPushNotifier({
      db,
      bus,
      config: buildConfig({ chatDelivery: false }),
      log: silentLogger(),
      away: fakeAway(true),
      sender,
    });

    bus.emit({ type: 'chat_delivery', instance: 'proj', fromNames: ['other'], count: 1, createdAt: Date.now() });
    await tick();

    expect(sender.send).not.toHaveBeenCalled();
    pn.stop();
  });
});
