import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { HubConfig, Logger } from '../types.js';
import { HubBus } from '../core/bus.js';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrations.js';
import * as messagesRepo from '../db/repo/messages.js';
import { startMessageSummarizer, summarize } from './messageSummarizer.js';

const readAccessTokenMock = vi.fn<() => string | null>();
vi.mock('../limit/credentials.js', () => ({
  readAccessToken: () => readAccessTokenMock(),
}));

function buildConfig(opts?: Partial<HubConfig['summaries']>): HubConfig {
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
    summaries: { enabled: true, model: 'claude-haiku-4-5', ...opts },
    attach: { enabled: true, heartbeatMs: 30_000, redactSecrets: true, fenceCodePastes: false },
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

function silentLogger(): Logger & { debug: ReturnType<typeof vi.fn> } {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function fakeFetchOk(text: string): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: 'text', text }] }),
  })) as unknown as typeof fetch;
}

function fakeFetchStatus(status: number): typeof fetch {
  return vi.fn(async () => ({ ok: false, status })) as unknown as typeof fetch;
}

function fakeFetchThrows(): typeof fetch {
  return vi.fn(async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;
}

describe('summarize', () => {
  beforeEach(() => {
    readAccessTokenMock.mockReset();
    readAccessTokenMock.mockReturnValue('fake-token');
  });

  it('returns the summarized text from the model', async () => {
    const result = await summarize('please fix the date bug', buildConfig(), silentLogger(), fakeFetchOk('fix date bug'));
    expect(result).toBe('fix date bug');
  });

  it('truncates the result to MAX_SUMMARY_CHARS', async () => {
    const longText = 'a'.repeat(100);
    const result = await summarize('message', buildConfig(), silentLogger(), fakeFetchOk(longText));
    expect(result?.length).toBeLessThanOrEqual(80);
  });

  it('returns null on a non-200 response', async () => {
    const log = silentLogger();
    const result = await summarize('some text', buildConfig(), log, fakeFetchStatus(500));
    expect(result).toBeNull();
    expect(log.debug).toHaveBeenCalled();
  });

  it('returns null when the fetch throws', async () => {
    const log = silentLogger();
    const result = await summarize('some text', buildConfig(), log, fakeFetchThrows());
    expect(result).toBeNull();
    expect(log.debug).toHaveBeenCalled();
  });

  it('returns null when there is no access token', async () => {
    readAccessTokenMock.mockReturnValue(null);
    const log = silentLogger();
    const result = await summarize('some text', buildConfig(), log, fakeFetchOk('fix bug'));
    expect(result).toBeNull();
    expect(log.debug).toHaveBeenCalled();
  });

  it('returns null for empty response text', async () => {
    const result = await summarize('message', buildConfig(), silentLogger(), fakeFetchOk(''));
    expect(result).toBeNull();
  });
});

describe('startMessageSummarizer', () => {
  beforeEach(() => {
    readAccessTokenMock.mockReset();
    readAccessTokenMock.mockReturnValue('fake-token');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('summarizes a message on bus emit', async () => {
    const db = buildDb();
    const bus = new HubBus();
    const log = silentLogger();
    const config = buildConfig();
    const mockFetch = fakeFetchOk('fix date bug');
    vi.stubGlobal('fetch', mockFetch);

    const summarizer = startMessageSummarizer({ db, bus, config, log });

    const now = Date.now();
    const message = messagesRepo.send(db, { from: 'a', to: 'b', body: 'please fix the date bug', urgent: false, now });
    expect(message.summary).toBeNull();

    bus.emit({ type: 'message', message });
    await summarizer.flush();

    const updated = db.prepare('SELECT * FROM messages WHERE id = ?').get(message.id) as typeof message;
    expect(updated.summary).toBe('fix date bug');

    summarizer.stop();
  });

  it('skips messages that already have a summary', async () => {
    const db = buildDb();
    const bus = new HubBus();
    const log = silentLogger();
    const config = buildConfig();
    const mockFetch = fakeFetchOk('new summary');
    vi.stubGlobal('fetch', mockFetch);

    const summarizer = startMessageSummarizer({ db, bus, config, log });

    const now = Date.now();
    const message = messagesRepo.send(db, { from: 'a', to: 'b', body: 'message text', urgent: false, now });
    messagesRepo.setSummary(db, message.id, 'existing summary');

    const withSummary = db.prepare('SELECT * FROM messages WHERE id = ?').get(message.id) as typeof message;
    bus.emit({ type: 'message', message: withSummary });
    await summarizer.flush();

    const final = db.prepare('SELECT * FROM messages WHERE id = ?').get(message.id) as typeof message;
    expect(final.summary).toBe('existing summary');
    expect(mockFetch).not.toHaveBeenCalled();

    summarizer.stop();
  });

  it('leaves summary NULL on fetch failure', async () => {
    const db = buildDb();
    const bus = new HubBus();
    const log = silentLogger();
    const config = buildConfig();
    const mockFetch = fakeFetchStatus(500);
    vi.stubGlobal('fetch', mockFetch);

    const summarizer = startMessageSummarizer({ db, bus, config, log });

    const now = Date.now();
    const message = messagesRepo.send(db, { from: 'a', to: 'b', body: 'message text', urgent: false, now });

    bus.emit({ type: 'message', message });
    await summarizer.flush();

    const final = db.prepare('SELECT * FROM messages WHERE id = ?').get(message.id) as typeof message;
    expect(final.summary).toBeNull();

    summarizer.stop();
  });

  it('does nothing when config.summaries.enabled is false', async () => {
    const db = buildDb();
    const bus = new HubBus();
    const log = silentLogger();
    const config = buildConfig({ enabled: false });
    const mockFetch = fakeFetchOk('fix bug');
    vi.stubGlobal('fetch', mockFetch);

    const summarizer = startMessageSummarizer({ db, bus, config, log });

    const now = Date.now();
    const message = messagesRepo.send(db, { from: 'a', to: 'b', body: 'message text', urgent: false, now });

    bus.emit({ type: 'message', message });
    await summarizer.flush();

    expect(mockFetch).not.toHaveBeenCalled();

    summarizer.stop();
  });
});
