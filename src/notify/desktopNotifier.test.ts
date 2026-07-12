import { describe, expect, it, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrations.js';
import { HubBus } from '../core/bus.js';
import * as instancesRepo from '../db/repo/instances.js';
import * as sessionsRepo from '../db/repo/sessions.js';
import type { HubConfig, LimitStateRow, Logger, PermissionRow } from '../types.js';

const notifyMock = vi.fn();
vi.mock('node-notifier', () => ({
  default: { notify: (...args: unknown[]) => notifyMock(...args) },
}));

const shouldNotifyIdlePromptMock = vi.fn<(...args: unknown[]) => Promise<boolean>>();
vi.mock('./needsInputFilter.js', () => ({
  shouldNotifyIdlePrompt: (...args: unknown[]) => shouldNotifyIdlePromptMock(...args),
}));

const { startDesktopNotifier, formatToolInput } = await import('./desktopNotifier.js');

async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

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
      enabled: false,
      awayThresholdMinutes: 3,
      apns: { keyPath: '', keyId: '', teamId: '', bundleId: 'com.righttechsoft.ccHubMobile', environment: 'production' },
    },
    logLevel: 'info',
  };
}

function silentLogger(): Logger & { debug: ReturnType<typeof vi.fn> } {
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

describe('formatToolInput', () => {
  it('picks the command field for Bash input', () => {
    expect(formatToolInput('Bash', '{"command":"ls -la"}')).toBe('Bash: ls -la');
  });

  it('picks the first question text for AskUserQuestion input', () => {
    const input = '{"questions":[{"question":"Raise Windows toast timeout?","options":["yes","no"]}]}';
    expect(formatToolInput('AskUserQuestion', input)).toBe('AskUserQuestion: Raise Windows toast timeout?');
  });

  it('falls back to a raw slice when the input is not JSON', () => {
    const raw = 'x'.repeat(200);
    expect(formatToolInput('Bash', raw)).toBe(`Bash: ${raw.slice(0, 80)}`);
  });

  it('returns the tool name alone for null input', () => {
    expect(formatToolInput('Bash', null)).toBe('Bash');
  });

  it('truncates a long picked value to 100 chars with an ellipsis', () => {
    const result = formatToolInput('Bash', JSON.stringify({ command: 'y'.repeat(200) }));
    expect(result).toHaveLength(100);
    expect(result.endsWith('…')).toBe(true);
    expect(result.startsWith('Bash: yyy')).toBe(true);
  });
});

describe('startDesktopNotifier', () => {
  beforeEach(() => {
    notifyMock.mockReset();
    shouldNotifyIdlePromptMock.mockReset();
  });

  it('toasts on permission_request when the toggle is on, resolving the instance name', () => {
    const db = buildDb();
    insertSession(db, 'proj', 'sess-1');
    const bus = new HubBus();
    const dn = startDesktopNotifier({ db, bus, config: buildConfig(), log: silentLogger() });

    bus.emit({ type: 'permission_request', request: fakePermission() });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const [opts] = notifyMock.mock.calls[0] as [{ title: string; message?: string }];
    expect(opts.title).toBe('proj — permission');
    expect(opts.message).toContain('Bash');
    expect(opts.message).toContain('ls -la');

    dn.stop();
  });

  it('does not toast on permission_request when the toggle is off', () => {
    const db = buildDb();
    insertSession(db, 'proj', 'sess-1');
    const bus = new HubBus();
    const dn = startDesktopNotifier({ db, bus, config: buildConfig({ permissionRequests: false }), log: silentLogger() });

    bus.emit({ type: 'permission_request', request: fakePermission() });

    expect(notifyMock).not.toHaveBeenCalled();
    dn.stop();
  });

  it('toasts on a Notification session_event carrying the payload message, when the toggle is on', () => {
    const db = buildDb();
    insertSession(db, 'proj', 'sess-1');
    const bus = new HubBus();
    const dn = startDesktopNotifier({ db, bus, config: buildConfig(), log: silentLogger() });

    bus.emit({
      type: 'session_event',
      sessionId: 'sess-1',
      eventType: 'Notification',
      payload: { notification_type: 'idle', message: 'Waiting for your input' },
      createdAt: Date.now(),
    });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const [opts] = notifyMock.mock.calls[0] as [{ title: string; message?: string }];
    expect(opts.title).toBe('proj needs input');
    expect(opts.message).toBe('Waiting for your input');

    dn.stop();
  });

  it('does not toast on a Notification session_event when the toggle is off', () => {
    const db = buildDb();
    insertSession(db, 'proj', 'sess-1');
    const bus = new HubBus();
    const dn = startDesktopNotifier({ db, bus, config: buildConfig({ needsInput: false }), log: silentLogger() });

    bus.emit({
      type: 'session_event',
      sessionId: 'sess-1',
      eventType: 'Notification',
      payload: { message: 'hi' },
      createdAt: Date.now(),
    });

    expect(notifyMock).not.toHaveBeenCalled();
    dn.stop();
  });

  it('suppresses an idle_prompt Notification while the session is still mid-turn (active)', () => {
    const db = buildDb();
    insertSession(db, 'proj', 'sess-1'); // upsertFromHook inserts status 'active'
    const bus = new HubBus();
    const log = silentLogger();
    const dn = startDesktopNotifier({ db, bus, config: buildConfig(), log });

    bus.emit({
      type: 'session_event',
      sessionId: 'sess-1',
      eventType: 'Notification',
      payload: { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' },
      createdAt: Date.now(),
    });

    expect(notifyMock).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledTimes(1);
    dn.stop();
  });

  it('toasts an idle_prompt Notification once the session has gone idle (Stop fired)', () => {
    const db = buildDb();
    insertSession(db, 'proj', 'sess-1');
    sessionsRepo.setStatus(db, 'sess-1', 'idle', Date.now());
    const bus = new HubBus();
    const dn = startDesktopNotifier({ db, bus, config: buildConfig(), log: silentLogger() });

    bus.emit({
      type: 'session_event',
      sessionId: 'sess-1',
      eventType: 'Notification',
      payload: { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' },
      createdAt: Date.now(),
    });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const [opts] = notifyMock.mock.calls[0] as [{ title: string; message?: string }];
    expect(opts.title).toBe('proj needs input');
    dn.stop();
  });

  it('suppresses an idle idle_prompt when aiIdleFilter is on and the filter resolves false', async () => {
    const db = buildDb();
    insertSession(db, 'proj', 'sess-1');
    sessionsRepo.setStatus(db, 'sess-1', 'idle', Date.now());
    shouldNotifyIdlePromptMock.mockResolvedValue(false);
    const bus = new HubBus();
    const dn = startDesktopNotifier({ db, bus, config: buildConfig({ aiIdleFilter: true }), log: silentLogger() });

    bus.emit({
      type: 'session_event',
      sessionId: 'sess-1',
      eventType: 'Notification',
      payload: { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' },
      createdAt: Date.now(),
    });
    await tick();

    expect(shouldNotifyIdlePromptMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).not.toHaveBeenCalled();
    dn.stop();
  });

  it('toasts an idle idle_prompt when aiIdleFilter is on and the filter resolves true', async () => {
    const db = buildDb();
    insertSession(db, 'proj', 'sess-1');
    sessionsRepo.setStatus(db, 'sess-1', 'idle', Date.now());
    shouldNotifyIdlePromptMock.mockResolvedValue(true);
    const bus = new HubBus();
    const dn = startDesktopNotifier({ db, bus, config: buildConfig({ aiIdleFilter: true }), log: silentLogger() });

    bus.emit({
      type: 'session_event',
      sessionId: 'sess-1',
      eventType: 'Notification',
      payload: { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' },
      createdAt: Date.now(),
    });
    await tick();

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const [opts] = notifyMock.mock.calls[0] as [{ title: string; message?: string }];
    expect(opts.title).toBe('proj needs input');
    dn.stop();
  });

  it('still toasts a permission_prompt Notification mid-turn (only idle_prompt is validated)', () => {
    const db = buildDb();
    insertSession(db, 'proj', 'sess-1'); // status 'active'
    const bus = new HubBus();
    const dn = startDesktopNotifier({ db, bus, config: buildConfig(), log: silentLogger() });

    bus.emit({
      type: 'session_event',
      sessionId: 'sess-1',
      eventType: 'Notification',
      payload: { notification_type: 'permission_prompt', message: 'Claude needs your permission' },
      createdAt: Date.now(),
    });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    dn.stop();
  });

  it('does not toast on a Stop session_event by default (turnEnd off)', () => {
    const db = buildDb();
    insertSession(db, 'proj', 'sess-1');
    const bus = new HubBus();
    const dn = startDesktopNotifier({ db, bus, config: buildConfig(), log: silentLogger() });

    bus.emit({ type: 'session_event', sessionId: 'sess-1', eventType: 'Stop', payload: null, createdAt: Date.now() });

    expect(notifyMock).not.toHaveBeenCalled();
    dn.stop();
  });

  it('toasts on a Stop session_event when turnEnd is enabled', () => {
    const db = buildDb();
    insertSession(db, 'proj', 'sess-1');
    const bus = new HubBus();
    const dn = startDesktopNotifier({ db, bus, config: buildConfig({ turnEnd: true }), log: silentLogger() });

    bus.emit({ type: 'session_event', sessionId: 'sess-1', eventType: 'Stop', payload: null, createdAt: Date.now() });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const [opts] = notifyMock.mock.calls[0] as [{ title: string }];
    expect(opts.title).toBe('proj finished a turn');

    dn.stop();
  });

  it('never toasts for permission_decided', () => {
    const db = buildDb();
    insertSession(db, 'proj', 'sess-1');
    const bus = new HubBus();
    const dn = startDesktopNotifier({ db, bus, config: buildConfig(), log: silentLogger() });

    bus.emit({ type: 'permission_decided', request: fakePermission({ status: 'allowed', decided_by: 'mobile' }) });

    expect(notifyMock).not.toHaveBeenCalled();
    dn.stop();
  });

  it('toasts on chat_delivery when the toggle is on', () => {
    const db = buildDb();
    const bus = new HubBus();
    const dn = startDesktopNotifier({ db, bus, config: buildConfig(), log: silentLogger() });

    bus.emit({
      type: 'chat_delivery',
      instance: 'proj',
      fromNames: ['other'],
      count: 2,
      createdAt: Date.now(),
    });

    expect(notifyMock).toHaveBeenCalledTimes(1);
    const [opts] = notifyMock.mock.calls[0] as [{ title: string; message?: string }];
    expect(opts.title).toBe('proj — incoming chat');
    expect(opts.message).toContain('2 messages');
    expect(opts.message).toContain('other');

    dn.stop();
  });

  it('does not toast on chat_delivery when notifications.chatDelivery is off', () => {
    const db = buildDb();
    const bus = new HubBus();
    const dn = startDesktopNotifier({ db, bus, config: buildConfig({ chatDelivery: false }), log: silentLogger() });

    bus.emit({
      type: 'chat_delivery',
      instance: 'proj',
      fromNames: ['other'],
      count: 1,
      createdAt: Date.now(),
    });

    expect(notifyMock).not.toHaveBeenCalled();
    dn.stop();
  });

  describe('limit_state transitions', () => {
    it('toasts once entering limited, not again while still limited, then once on recovery to ok', () => {
      const db = buildDb();
      const bus = new HubBus();
      const dn = startDesktopNotifier({ db, bus, config: buildConfig(), log: silentLogger() });

      bus.emit({ type: 'limit_state', state: fakeLimitState('limited') });
      expect(notifyMock).toHaveBeenCalledTimes(1);

      bus.emit({ type: 'limit_state', state: fakeLimitState('limited') });
      expect(notifyMock).toHaveBeenCalledTimes(1);

      bus.emit({ type: 'limit_state', state: fakeLimitState('ok') });
      expect(notifyMock).toHaveBeenCalledTimes(2);
      const [opts] = notifyMock.mock.calls[1] as [{ title: string; message?: string }];
      expect(opts.message).toMatch(/reset/i);

      dn.stop();
    });

    it('does not toast for waiting_reset/continuing/unknown, and still recovers correctly through them', () => {
      const db = buildDb();
      const bus = new HubBus();
      const dn = startDesktopNotifier({ db, bus, config: buildConfig(), log: silentLogger() });

      bus.emit({ type: 'limit_state', state: fakeLimitState('limited') });
      expect(notifyMock).toHaveBeenCalledTimes(1);

      bus.emit({ type: 'limit_state', state: fakeLimitState('waiting_reset') });
      bus.emit({ type: 'limit_state', state: fakeLimitState('continuing') });
      bus.emit({ type: 'limit_state', state: fakeLimitState('unknown') });
      expect(notifyMock).toHaveBeenCalledTimes(1);

      bus.emit({ type: 'limit_state', state: fakeLimitState('ok') });
      expect(notifyMock).toHaveBeenCalledTimes(2);

      dn.stop();
    });

    it('does not toast when starting in ok (no prior limited episode)', () => {
      const db = buildDb();
      const bus = new HubBus();
      const dn = startDesktopNotifier({ db, bus, config: buildConfig(), log: silentLogger() });

      bus.emit({ type: 'limit_state', state: fakeLimitState('ok') });

      expect(notifyMock).not.toHaveBeenCalled();
      dn.stop();
    });

    it('does not toast when the limit toggle is off', () => {
      const db = buildDb();
      const bus = new HubBus();
      const dn = startDesktopNotifier({ db, bus, config: buildConfig({ limit: false }), log: silentLogger() });

      bus.emit({ type: 'limit_state', state: fakeLimitState('limited') });
      bus.emit({ type: 'limit_state', state: fakeLimitState('ok') });

      expect(notifyMock).not.toHaveBeenCalled();
      dn.stop();
    });
  });

  it('does not crash when notify throws, and logs it at debug level', () => {
    notifyMock.mockImplementation(() => {
      throw new Error('boom');
    });

    const db = buildDb();
    const bus = new HubBus();
    const log = silentLogger();
    const dn = startDesktopNotifier({ db, bus, config: buildConfig(), log });

    expect(() => bus.emit({ type: 'limit_state', state: fakeLimitState('limited') })).not.toThrow();
    expect(log.debug).toHaveBeenCalledTimes(1);

    dn.stop();
  });

  it('stop() unsubscribes from the bus', () => {
    const db = buildDb();
    const bus = new HubBus();
    const dn = startDesktopNotifier({ db, bus, config: buildConfig(), log: silentLogger() });

    dn.stop();
    bus.emit({ type: 'limit_state', state: fakeLimitState('limited') });

    expect(notifyMock).not.toHaveBeenCalled();
  });
});
