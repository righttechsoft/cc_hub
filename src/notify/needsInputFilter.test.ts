import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { HubConfig, Logger } from '../types.js';

const readAccessTokenMock = vi.fn<() => string | null>();
vi.mock('../limit/credentials.js', () => ({
  readAccessToken: () => readAccessTokenMock(),
}));

const { parseLastAssistantText, classifyNeedsInput } = await import('./needsInputFilter.js');

function assistantLine(text: string, opts?: { isSidechain?: boolean }): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: opts?.isSidechain ?? false,
    message: { content: [{ type: 'text', text }] },
  });
}

function assistantToolUseLine(): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }] },
  });
}

function userLine(text: string): string {
  return JSON.stringify({ type: 'user', message: { content: text } });
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
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
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

describe('parseLastAssistantText', () => {
  it('picks the newest assistant text line', () => {
    const tail = [
      assistantLine('first status update'),
      userLine('ok thanks'),
      assistantLine('final status update — all done'),
    ].join('\n');

    expect(parseLastAssistantText(tail)).toBe('final status update — all done');
  });

  it('skips sidechain lines', () => {
    const tail = [
      assistantLine('the real answer'),
      assistantLine('a sub-agent aside', { isSidechain: true }),
    ].join('\n');

    expect(parseLastAssistantText(tail)).toBe('the real answer');
  });

  it('skips a truncated first line without throwing', () => {
    const tail = ['{"type":"assistant","message":{"content":[{"type":"text","text":"cut off', assistantLine('good answer')].join(
      '\n'
    );

    expect(parseLastAssistantText(tail)).toBe('good answer');
  });

  it('skips assistant entries with only tool_use blocks', () => {
    const tail = [assistantLine('earlier text reply'), assistantToolUseLine()].join('\n');

    expect(parseLastAssistantText(tail)).toBe('earlier text reply');
  });

  it('returns null when no assistant text entry is found', () => {
    const tail = [userLine('hello'), assistantToolUseLine(), assistantLine('sidechain only', { isSidechain: true })].join(
      '\n'
    );

    expect(parseLastAssistantText(tail)).toBeNull();
  });
});

describe('classifyNeedsInput', () => {
  beforeEach(() => {
    readAccessTokenMock.mockReset();
    readAccessTokenMock.mockReturnValue('fake-token');
  });

  it('returns needs_input when the model answers YES', async () => {
    const verdict = await classifyNeedsInput('Should I proceed?', buildConfig(), silentLogger(), fakeFetchOk('YES'));
    expect(verdict).toBe('needs_input');
  });

  it('returns no_action when the model answers NO', async () => {
    const verdict = await classifyNeedsInput('Build finished successfully.', buildConfig(), silentLogger(), fakeFetchOk('NO'));
    expect(verdict).toBe('no_action');
  });

  it('returns unknown on a non-200 response', async () => {
    const log = silentLogger();
    const verdict = await classifyNeedsInput('some text', buildConfig(), log, fakeFetchStatus(500));
    expect(verdict).toBe('unknown');
    expect(log.debug).toHaveBeenCalled();
  });

  it('returns unknown when the fetch throws', async () => {
    const log = silentLogger();
    const verdict = await classifyNeedsInput('some text', buildConfig(), log, fakeFetchThrows());
    expect(verdict).toBe('unknown');
    expect(log.debug).toHaveBeenCalled();
  });

  it('returns unknown when there is no access token', async () => {
    readAccessTokenMock.mockReturnValue(null);
    const log = silentLogger();
    const verdict = await classifyNeedsInput('some text', buildConfig(), log, fakeFetchOk('YES'));
    expect(verdict).toBe('unknown');
    expect(log.debug).toHaveBeenCalled();
  });
});
