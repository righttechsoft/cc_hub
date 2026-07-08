import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrations.js';
import { startChatDelivery, type ChatDelivery } from './chatDelivery.js';
import * as instancesRepo from '../db/repo/instances.js';
import * as sessionsRepo from '../db/repo/sessions.js';
import * as messagesRepo from '../db/repo/messages.js';
import * as promptsRepo from '../db/repo/prompts.js';
import type { HubConfig, IPromptDelivery, Logger, SessionStatus } from '../types.js';

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
      permissionMode: 'default',
    },
    retention: { sessionEventsDays: 14, messagesDays: 90 },
    relay: { enabled: false, url: '', secret: '' },
    chatDelivery: {
      enabled: true,
      tickMs: 30_000,
      maxPerSessionPerHour: 3,
      maxSessionIdleAgeMinutes: 60,
      ...opts,
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

function fakeDelivery(): IPromptDelivery & { send: ReturnType<typeof vi.fn> } {
  return {
    // Mirrors PromptDelivery.send: invoke onSettled(true) to simulate the spawned turn
    // completing successfully, so callers relying on it (e.g. chatDelivery's markRead) behave
    // the same as against the real implementation.
    send: vi.fn(async (_sessionId: string, _prompt: string, _source: string, onSettled?: (ok: boolean) => void) => {
      onSettled?.(true);
      return { delivery: 'spawned' as const, pendingPromptId: 1 };
    }),
    claimForStopBlock: () => undefined,
  };
}

function insertInstance(db: Database.Database, name: string): number {
  return instancesRepo.upsert(db, { name, cwd: `/proj-${name}`, now: Date.now() }).id;
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
  delivery: IPromptDelivery
): TickableChatDelivery {
  const cd = startChatDelivery({ db, log, config, delivery }) as TickableChatDelivery;
  cd.stop();
  return cd;
}

describe('startChatDelivery', () => {
  it('delivers unread direct messages to an idle session and marks them read', async () => {
    const db = buildDb();
    const senderId = insertInstance(db, 'sender');
    const recipientId = insertInstance(db, 'recipient');
    const now = Date.now();
    insertSession(db, { id: 'sess-1', instanceId: recipientId, status: 'idle', lastEventAt: now });
    messagesRepo.send(db, { from: 'sender', to: 'recipient', body: 'hello there', urgent: false, now });

    const delivery = fakeDelivery();
    const config = buildConfig();
    const chatDelivery = startDelivery(db, config, silentLogger(), delivery);

    await chatDelivery._tick();

    expect(delivery.send).toHaveBeenCalledTimes(1);
    const [sessionId, prompt, source] = delivery.send.mock.calls[0];
    expect(sessionId).toBe('sess-1');
    expect(prompt).toContain('hello there');
    expect(source).toBe('chat');
    expect(messagesRepo.unreadFor(db, 'recipient')).toHaveLength(0);

    void senderId;
  });

  it('does not deliver to an active session', async () => {
    const db = buildDb();
    insertInstance(db, 'sender');
    const recipientId = insertInstance(db, 'recipient');
    const now = Date.now();
    insertSession(db, { id: 'sess-2', instanceId: recipientId, status: 'active', lastEventAt: now });
    messagesRepo.send(db, { from: 'sender', to: 'recipient', body: 'still here?', urgent: false, now });

    const delivery = fakeDelivery();
    const chatDelivery = startDelivery(db, buildConfig(), silentLogger(), delivery);

    await chatDelivery._tick();

    expect(delivery.send).not.toHaveBeenCalled();
  });

  it('skips an idle session whose last_event_at is older than maxSessionIdleAgeMinutes', async () => {
    const db = buildDb();
    insertInstance(db, 'sender');
    const recipientId = insertInstance(db, 'recipient');
    const now = Date.now();
    const config = buildConfig({ maxSessionIdleAgeMinutes: 60 });
    const staleLastEventAt = now - 70 * 60_000; // older than the 60-minute cutoff
    insertSession(db, { id: 'sess-3', instanceId: recipientId, status: 'idle', lastEventAt: staleLastEventAt });
    messagesRepo.send(db, { from: 'sender', to: 'recipient', body: 'ping', urgent: false, now });

    const delivery = fakeDelivery();
    const chatDelivery = startDelivery(db, config, silentLogger(), delivery);

    await chatDelivery._tick();

    expect(delivery.send).not.toHaveBeenCalled();
  });

  it('skips a session that already hit its hourly chat-delivery cap', async () => {
    const db = buildDb();
    insertInstance(db, 'sender');
    const recipientId = insertInstance(db, 'recipient');
    const now = Date.now();
    const config = buildConfig({ maxPerSessionPerHour: 2 });
    insertSession(db, { id: 'sess-4', instanceId: recipientId, status: 'idle', lastEventAt: now });
    messagesRepo.send(db, { from: 'sender', to: 'recipient', body: 'capped', urgent: false, now });

    for (let i = 0; i < config.chatDelivery.maxPerSessionPerHour; i++) {
      promptsRepo.enqueue(db, {
        sessionId: 'sess-4',
        prompt: 'earlier chat delivery',
        source: 'chat',
        status: 'delivered',
        now: now - 10_000,
      });
    }

    const delivery = fakeDelivery();
    const chatDelivery = startDelivery(db, config, silentLogger(), delivery);

    await chatDelivery._tick();

    expect(delivery.send).not.toHaveBeenCalled();
  });

  it('delivers a broadcast message to idle sessions of both other instances, not the sender', async () => {
    const db = buildDb();
    const senderId = insertInstance(db, 'sender');
    const aId = insertInstance(db, 'instance-a');
    const bId = insertInstance(db, 'instance-b');
    const now = Date.now();
    insertSession(db, { id: 'sess-sender', instanceId: senderId, status: 'idle', lastEventAt: now });
    insertSession(db, { id: 'sess-a', instanceId: aId, status: 'idle', lastEventAt: now });
    insertSession(db, { id: 'sess-b', instanceId: bId, status: 'idle', lastEventAt: now });
    messagesRepo.send(db, { from: 'sender', to: null, body: 'broadcast news', urgent: false, now });

    const delivery = fakeDelivery();
    const chatDelivery = startDelivery(db, buildConfig(), silentLogger(), delivery);

    await chatDelivery._tick();

    expect(delivery.send).toHaveBeenCalledTimes(2);
    const deliveredSessionIds = delivery.send.mock.calls.map((call) => call[0]);
    expect(deliveredSessionIds).toEqual(expect.arrayContaining(['sess-a', 'sess-b']));
    expect(deliveredSessionIds).not.toContain('sess-sender');
  });

  it('batches large unread sets across ticks to stay under the Windows argv limit', async () => {
    const db = buildDb();
    insertInstance(db, 'sender');
    const recipientId = insertInstance(db, 'recipient');
    const now = Date.now();
    insertSession(db, { id: 'sess-batch', instanceId: recipientId, status: 'idle', lastEventAt: now });

    const bigBody = 'x'.repeat(8000);
    for (let i = 0; i < 4; i++) {
      messagesRepo.send(db, { from: 'sender', to: 'recipient', body: bigBody, urgent: false, now: now + i });
    }

    const delivery = fakeDelivery();
    const chatDelivery = startDelivery(db, buildConfig(), silentLogger(), delivery);

    await chatDelivery._tick();

    expect(delivery.send).toHaveBeenCalledTimes(1);
    const firstPrompt = delivery.send.mock.calls[0][1] as string;
    expect(firstPrompt.length).toBeLessThan(32_000);
    // Budget is 20000 chars; two 8000-char bodies fit (16000) but a third would not (24000).
    const stillUnread = messagesRepo.unreadFor(db, 'recipient');
    expect(stillUnread).toHaveLength(2);

    await chatDelivery._tick();

    expect(delivery.send).toHaveBeenCalledTimes(2);
    expect(messagesRepo.unreadFor(db, 'recipient')).toHaveLength(0);
  });

  it('delivers only to the most recently idle session when an instance has two idle sessions', async () => {
    const db = buildDb();
    insertInstance(db, 'sender');
    const recipientId = insertInstance(db, 'recipient');
    const now = Date.now();
    insertSession(db, { id: 'sess-old', instanceId: recipientId, status: 'idle', lastEventAt: now - 5_000 });
    insertSession(db, { id: 'sess-new', instanceId: recipientId, status: 'idle', lastEventAt: now });
    messagesRepo.send(db, { from: 'sender', to: 'recipient', body: 'which one?', urgent: false, now });

    const delivery = fakeDelivery();
    const chatDelivery = startDelivery(db, buildConfig(), silentLogger(), delivery);

    await chatDelivery._tick();

    expect(delivery.send).toHaveBeenCalledTimes(1);
    expect(delivery.send.mock.calls[0][0]).toBe('sess-new');
  });
});
