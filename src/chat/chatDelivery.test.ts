import { describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrations.js';
import { startChatDelivery, type ChatDelivery } from './chatDelivery.js';
import { HubBus } from '../core/bus.js';
import * as instancesRepo from '../db/repo/instances.js';
import * as sessionsRepo from '../db/repo/sessions.js';
import * as messagesRepo from '../db/repo/messages.js';
import type { HubConfig, HubEvent, IClaudeRunner, Logger, RunResult, SessionStatus } from '../types.js';

type TickableChatDelivery = ChatDelivery & { _tick(): Promise<void> };

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function buildConfig(opts?: Partial<HubConfig['chatDelivery']>): HubConfig {
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
      ...opts,
    },
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
    },
    push: {
      enabled: false,
      awayThresholdMinutes: 3,
      apns: { keyPath: '', keyId: '', teamId: '', bundleId: 'com.righttechsoft.ccHubMobile', environment: 'production' },
    },
    logLevel: 'info',
  };
}

function silentLogger(): Logger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function fakeRunResult(overrides?: Partial<RunResult>): RunResult {
  return { code: 0, stdout: '', stderr: '', startedAt: 0, endedAt: 0, ...overrides };
}

function fakeRunner(opts?: {
  startNew?: ReturnType<typeof vi.fn>;
  runningCwd?: (cwd: string) => boolean;
  atCapacity?: boolean;
}): IClaudeRunner & { startNew: ReturnType<typeof vi.fn> } {
  return {
    startNew: opts?.startNew ?? vi.fn().mockResolvedValue(fakeRunResult()),
    resumePrompt: vi.fn(),
    isRunning: () => false,
    runningCwd: opts?.runningCwd ?? (() => false),
    atCapacity: () => opts?.atCapacity ?? false,
  };
}

// startNew is fire-and-forget from tick()'s perspective (see chatDelivery.ts) — flush the
// microtask/macrotask queue after awaiting _tick() so its .then/.catch has had a chance to run
// before assertions that depend on it (markRead, logging).
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function insertInstance(db: Database.Database, name: string, cwd?: string): number {
  return instancesRepo.upsert(db, { name, cwd: cwd ?? `/proj-${name}`, now: Date.now() }).id;
}

function insertSession(
  db: Database.Database,
  opts: { id: string; instanceId: number; status: SessionStatus; lastEventAt: number }
): void {
  sessionsRepo.upsertFromHook(db, {
    sessionId: opts.id,
    cwd: '/proj',
    transcriptPath: null,
    instanceId: opts.instanceId,
    now: opts.lastEventAt,
  });
  if (opts.status !== 'active') {
    sessionsRepo.setStatus(db, opts.id, opts.status, opts.lastEventAt);
  }
}

// Constructs the delivery loop then immediately cancels its bootstrap timer (armed via
// scheduleNext(config.chatDelivery.tickMs) inside startChatDelivery) so tests can drive every
// tick deterministically via _tick(), mirroring src/limit/watcher.test.ts's startWatcher.
function startDelivery(
  db: Database.Database,
  config: HubConfig,
  log: Logger,
  runner: IClaudeRunner = fakeRunner(),
  bus: HubBus = new HubBus()
): TickableChatDelivery {
  const cd = startChatDelivery({ db, log, config, runner, bus }) as TickableChatDelivery;
  cd.stop();
  return cd;
}

describe('startChatDelivery', () => {
  it('spawns a new session for an instance with unread mail and no active session, marking read on exit code 0', async () => {
    const db = buildDb();
    insertInstance(db, 'sender');
    const cwd = tmpdir();
    insertInstance(db, 'recipient', cwd);
    const now = Date.now();
    messagesRepo.send(db, { from: 'sender', to: 'recipient', body: 'anybody home', urgent: false, now });

    const startNew = vi.fn().mockResolvedValue(fakeRunResult({ code: 0 }));
    const runner = fakeRunner({ startNew });
    const chatDelivery = startDelivery(db, buildConfig(), silentLogger(), runner);

    await chatDelivery._tick();
    await flushAsync();

    expect(startNew).toHaveBeenCalledTimes(1);
    const [arg] = startNew.mock.calls[0] as [{ cwd: string; prompt: string }];
    expect(arg.cwd).toBe(cwd);
    expect(arg.prompt).toContain('anybody home');

    expect(messagesRepo.unreadFor(db, 'recipient')).toHaveLength(0);
    const reads = db
      .prepare('SELECT via FROM message_reads WHERE reader_name = ?')
      .all('recipient') as { via: string | null }[];
    expect(reads).toHaveLength(1);
    expect(reads[0].via).toBe('chat_delivery');
  });

  it('leaves messages unread when the spawned session exits non-zero', async () => {
    const db = buildDb();
    insertInstance(db, 'sender');
    const cwd = tmpdir();
    insertInstance(db, 'recipient', cwd);
    const now = Date.now();
    messagesRepo.send(db, { from: 'sender', to: 'recipient', body: 'ping', urgent: false, now });

    const startNew = vi.fn().mockResolvedValue(fakeRunResult({ code: 1, stderr: 'boom' }));
    const runner = fakeRunner({ startNew });
    const chatDelivery = startDelivery(db, buildConfig(), silentLogger(), runner);

    await chatDelivery._tick();
    await flushAsync();

    expect(startNew).toHaveBeenCalledTimes(1);
    expect(messagesRepo.unreadFor(db, 'recipient')).toHaveLength(1);
  });

  it('does not spawn when the instance has an active session — its own hooks deliver instead', async () => {
    const db = buildDb();
    insertInstance(db, 'sender');
    const cwd = tmpdir();
    const recipientId = insertInstance(db, 'recipient', cwd);
    const now = Date.now();
    insertSession(db, { id: 'sess-active', instanceId: recipientId, status: 'active', lastEventAt: now });
    messagesRepo.send(db, { from: 'sender', to: 'recipient', body: 'still here?', urgent: false, now });

    const startNew = vi.fn();
    const runner = fakeRunner({ startNew });
    const chatDelivery = startDelivery(db, buildConfig(), silentLogger(), runner);

    await chatDelivery._tick();
    await flushAsync();

    expect(startNew).not.toHaveBeenCalled();
  });

  it('spawns even when the instance only has an idle session — idle no longer blocks delivery', async () => {
    const db = buildDb();
    insertInstance(db, 'sender');
    const cwd = tmpdir();
    const recipientId = insertInstance(db, 'recipient', cwd);
    const now = Date.now();
    insertSession(db, { id: 'sess-idle', instanceId: recipientId, status: 'idle', lastEventAt: now });
    messagesRepo.send(db, { from: 'sender', to: 'recipient', body: 'hello there', urgent: false, now });

    const startNew = vi.fn().mockResolvedValue(fakeRunResult({ code: 0 }));
    const runner = fakeRunner({ startNew });
    const chatDelivery = startDelivery(db, buildConfig(), silentLogger(), runner);

    await chatDelivery._tick();
    await flushAsync();

    expect(startNew).toHaveBeenCalledTimes(1);
    const [arg] = startNew.mock.calls[0] as [{ cwd: string; prompt: string }];
    expect(arg.cwd).toBe(cwd);
    expect(messagesRepo.unreadFor(db, 'recipient')).toHaveLength(0);
  });

  it('stops spawning once the per-instance hourly cap is reached', async () => {
    const db = buildDb();
    insertInstance(db, 'sender');
    const cwd = tmpdir();
    insertInstance(db, 'recipient', cwd);
    const now = Date.now();
    messagesRepo.send(db, { from: 'sender', to: 'recipient', body: 'still unread', urgent: false, now });

    // Fails every time so the message stays unread and every tick re-attempts a spawn.
    const startNew = vi.fn().mockResolvedValue(fakeRunResult({ code: 1 }));
    const runner = fakeRunner({ startNew });
    const config = buildConfig({ maxSpawnsPerInstancePerHour: 2 });
    const chatDelivery = startDelivery(db, config, silentLogger(), runner);

    await chatDelivery._tick();
    await flushAsync();
    await chatDelivery._tick();
    await flushAsync();
    await chatDelivery._tick();
    await flushAsync();

    expect(startNew).toHaveBeenCalledTimes(2);
  });

  it('skips without throwing when the instance cwd does not exist', async () => {
    const db = buildDb();
    insertInstance(db, 'sender');
    const missingCwd = join(tmpdir(), 'cc_hub-chatdelivery-test-missing-dir-xyz');
    insertInstance(db, 'recipient', missingCwd);
    const now = Date.now();
    messagesRepo.send(db, { from: 'sender', to: 'recipient', body: 'hi', urgent: false, now });

    const startNew = vi.fn();
    const runner = fakeRunner({ startNew });
    const chatDelivery = startDelivery(db, buildConfig(), silentLogger(), runner);

    await expect(chatDelivery._tick()).resolves.toBeUndefined();
    await flushAsync();

    expect(startNew).not.toHaveBeenCalled();
  });

  it('batches large unread sets across ticks to stay under the Windows argv limit', async () => {
    const db = buildDb();
    insertInstance(db, 'sender');
    const cwd = tmpdir();
    insertInstance(db, 'recipient', cwd);
    const now = Date.now();

    const bigBody = 'x'.repeat(8000);
    for (let i = 0; i < 4; i++) {
      messagesRepo.send(db, { from: 'sender', to: 'recipient', body: bigBody, urgent: false, now: now + i });
    }

    const startNew = vi.fn().mockResolvedValue(fakeRunResult({ code: 0 }));
    const runner = fakeRunner({ startNew });
    const chatDelivery = startDelivery(db, buildConfig(), silentLogger(), runner);

    await chatDelivery._tick();
    await flushAsync();

    expect(startNew).toHaveBeenCalledTimes(1);
    const firstPrompt = (startNew.mock.calls[0][0] as { prompt: string }).prompt;
    expect(firstPrompt.length).toBeLessThan(32_000);
    // Budget is 20000 chars; two 8000-char bodies fit (16000) but a third would not (24000).
    const stillUnread = messagesRepo.unreadFor(db, 'recipient');
    expect(stillUnread).toHaveLength(2);

    await chatDelivery._tick();
    await flushAsync();

    expect(startNew).toHaveBeenCalledTimes(2);
    expect(messagesRepo.unreadFor(db, 'recipient')).toHaveLength(0);
  });

  it('emits a chat_delivery bus event at dispatch, with unique from_names in first-seen order', async () => {
    const db = buildDb();
    insertInstance(db, 'sender-a');
    insertInstance(db, 'sender-b');
    const cwd = tmpdir();
    insertInstance(db, 'recipient', cwd);
    const now = Date.now();
    messagesRepo.send(db, { from: 'sender-a', to: 'recipient', body: 'one', urgent: false, now });
    messagesRepo.send(db, { from: 'sender-b', to: 'recipient', body: 'two', urgent: false, now: now + 1 });
    messagesRepo.send(db, { from: 'sender-a', to: 'recipient', body: 'three', urgent: false, now: now + 2 });

    const runner = fakeRunner();
    const bus = new HubBus();
    const events: HubEvent[] = [];
    bus.on((e) => events.push(e));
    const chatDelivery = startDelivery(db, buildConfig(), silentLogger(), runner, bus);

    await chatDelivery._tick();
    await flushAsync();

    const delivered = events.filter((e) => e.type === 'chat_delivery');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      type: 'chat_delivery',
      instance: 'recipient',
      fromNames: ['sender-a', 'sender-b'],
      count: 3,
    });
  });

  it('does not emit a chat_delivery event when delivery is skipped (active session)', async () => {
    const db = buildDb();
    insertInstance(db, 'sender');
    const cwd = tmpdir();
    const recipientId = insertInstance(db, 'recipient', cwd);
    const now = Date.now();
    insertSession(db, { id: 'sess-active', instanceId: recipientId, status: 'active', lastEventAt: now });
    messagesRepo.send(db, { from: 'sender', to: 'recipient', body: 'still here?', urgent: false, now });

    const runner = fakeRunner();
    const bus = new HubBus();
    const events: HubEvent[] = [];
    bus.on((e) => events.push(e));
    const chatDelivery = startDelivery(db, buildConfig(), silentLogger(), runner, bus);

    await chatDelivery._tick();
    await flushAsync();

    expect(events.filter((e) => e.type === 'chat_delivery')).toHaveLength(0);
  });
});
