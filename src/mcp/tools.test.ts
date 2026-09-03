import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runMigrations } from '../db/migrations.js';
import { HubBus } from '../core/bus.js';
import * as instancesRepo from '../db/repo/instances.js';
import * as instanceAppsRepo from '../db/repo/instanceApps.js';
import * as sessionsRepo from '../db/repo/sessions.js';
import { createAthen } from '../kb/athen.js';
import type { Embedder } from '../kb/embedder.js';
import { registerHubTools, type HubToolsContext } from './tools.js';
import type { Logger } from '../types.js';

type ToolHandler = (args: Record<string, unknown>, extra?: unknown) => unknown;

function silentLogger(): Logger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

// registerHubTools only needs an object with registerTool; capture the handlers so tests can
// invoke them directly without the MCP SDK transport machinery.
function captureTools(ctx: HubToolsContext): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    registerTool: (name: string, _meta: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  registerHubTools(server, ctx);
  return tools;
}

function buildCtx(
  db: Database.Database,
  pokeChatDelivery?: () => void,
  embedder?: Embedder
): HubToolsContext {
  const log = silentLogger();
  return {
    db,
    bus: new HubBus(),
    log,
    athen: createAthen({ db, log, embedder }),
    getIdentity: () => ({ instanceName: 'alpha', cwd: '/alpha' }),
    bind: () => {},
    pokeChatDelivery,
  };
}

describe('hub_register', () => {
  it('with no name, derives an instance name from cwd (existing behavior)', () => {
    const db = buildDb();
    const tools = captureTools(buildCtx(db));

    const result = tools.get('hub_register')!({ cwd: 'F:\\rts\\wonkybox' }) as { content: { text: string }[] };
    const parsed = JSON.parse(result.content[0].text) as { instanceName: string };

    expect(parsed.instanceName).toBe('wonkybox');
    expect(instancesRepo.byName(db, 'wonkybox')?.cwd).toBe('F:\\rts\\wonkybox');
  });

  it('with an explicit name, creates/reuses that named identity instead of the cwd-derived one', () => {
    const db = buildDb();
    const tools = captureTools(buildCtx(db));

    const result = tools.get('hub_register')!({ cwd: 'F:\\rts\\wonkybox', name: 'wb-sync' }) as {
      content: { text: string }[];
    };
    const parsed = JSON.parse(result.content[0].text) as { instanceName: string };

    expect(parsed.instanceName).toBe('wb-sync');
    expect(instancesRepo.byName(db, 'wb-sync')?.cwd).toBe('F:\\rts\\wonkybox');
  });

  it('lowercases an explicit name before validating/using it', () => {
    const db = buildDb();
    const tools = captureTools(buildCtx(db));

    const result = tools.get('hub_register')!({ cwd: 'F:\\rts\\wonkybox', name: 'WB-Sync' }) as {
      content: { text: string }[];
    };
    expect(JSON.parse(result.content[0].text).instanceName).toBe('wb-sync');
  });

  it('rejects a name that fails INSTANCE_NAME_RE', () => {
    const db = buildDb();
    const tools = captureTools(buildCtx(db));

    const result = tools.get('hub_register')!({ cwd: 'F:\\rts\\wonkybox', name: '-bad' }) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid name');
  });

  it('disambiguates an explicit name already claimed by a different cwd, with a numeric suffix', () => {
    const db = buildDb();
    instancesRepo.upsertNamed(db, { name: 'wb-sync', cwd: 'F:\\rts\\other', now: Date.now() });
    const tools = captureTools(buildCtx(db));

    const result = tools.get('hub_register')!({ cwd: 'F:\\rts\\wonkybox', name: 'wb-sync' }) as {
      content: { text: string }[];
    };
    expect(JSON.parse(result.content[0].text).instanceName).toBe('wb-sync-2');
  });

  it('reuses the existing row when the explicit name is already this cwd\'s own (idempotent re-register)', () => {
    const db = buildDb();
    const tools = captureTools(buildCtx(db));
    tools.get('hub_register')!({ cwd: 'F:\\rts\\wonkybox', name: 'wb-sync' });

    const result = tools.get('hub_register')!({ cwd: 'F:\\rts\\wonkybox', name: 'wb-sync' }) as {
      content: { text: string }[];
    };
    expect(JSON.parse(result.content[0].text).instanceName).toBe('wb-sync');
    expect(instancesRepo.list(db).filter((i) => i.name === 'wb-sync')).toHaveLength(1);
  });

  // Regression coverage for the bug where an MCP-calling agent in a named cc-attach terminal
  // (whose SESSION is already bound to the named instance via CC_HUB_NAME/hooks) would call
  // hub_register with only cwd and get rebound to the folder's cwd-derived default instance —
  // collapsing every named task agent sharing that folder into one chat identity.
  it('an explicit name still wins over a bound session_id and over cwd', () => {
    const db = buildDb();
    const now = Date.now();
    const named = instancesRepo.upsertNamed(db, { name: 'spawn-smoke', cwd: 'F:\\rts\\proj', now });
    sessionsRepo.upsertFromHook(db, {
      sessionId: 'sess-1',
      cwd: 'F:\\rts\\proj',
      transcriptPath: null,
      instanceId: named.id,
      now,
    });

    const tools = captureTools(buildCtx(db));
    const result = tools.get('hub_register')!(
      { cwd: 'F:\\rts\\proj', name: 'explicit-name', session_id: 'sess-1' },
      { sessionId: 'mcp-test' }
    ) as { content: { text: string }[] };

    expect(JSON.parse(result.content[0].text).instanceName).toBe('explicit-name');
  });

  it('REGRESSION: session_id bound to a NAMED instance resolves to that instance, not the cwd default', () => {
    const db = buildDb();
    const now = Date.now();
    const named = instancesRepo.upsertNamed(db, { name: 'spawn-smoke', cwd: 'F:\\rts\\proj', now });
    sessionsRepo.upsertFromHook(db, {
      sessionId: 'sess-1',
      cwd: 'F:\\rts\\proj',
      transcriptPath: null,
      instanceId: named.id,
      now,
    });

    const tools = captureTools(buildCtx(db));
    const result = tools.get('hub_register')!(
      { cwd: 'F:\\rts\\proj', session_id: 'sess-1' },
      { sessionId: 'mcp-test' }
    ) as { content: { text: string }[] };

    expect(JSON.parse(result.content[0].text).instanceName).toBe('spawn-smoke');
    // No spurious cwd-derived default row ("proj") should have been created for this folder.
    expect(instancesRepo.byCwd(db, 'F:\\rts\\proj')).toBeUndefined();
  });

  it('an unknown/unbound session_id falls back to the cwd default', () => {
    const db = buildDb();

    const tools = captureTools(buildCtx(db));
    const result = tools.get('hub_register')!(
      { cwd: 'F:\\rts\\wonkybox', session_id: 'no-such-session' },
      { sessionId: 'mcp-test' }
    ) as { content: { text: string }[] };

    expect(JSON.parse(result.content[0].text).instanceName).toBe('wonkybox');
  });

  // Tier 3 — regression coverage for the bug where a dispatched task agent's MCP call, made with
  // only `cwd` (no session_id/name — models don't reliably pass either even when told their
  // identity), resolved to the folder's cwd-derived default instance instead of the terminal's
  // own named task identity. hub_register now falls back to the sole active session in that cwd
  // bound to a NAMED instance, before ever deriving a cwd default.
  it('REGRESSION: cwd-only call with exactly one active named session in that cwd binds to it, not the cwd default', () => {
    const db = buildDb();
    const now = Date.now();
    const named = instancesRepo.upsertNamed(db, { name: 'spawn-smoke2', cwd: 'F:\\rts\\proj', now });
    sessionsRepo.upsertFromHook(db, {
      sessionId: 'sess-1',
      cwd: 'F:\\rts\\proj',
      transcriptPath: null,
      instanceId: named.id,
      now,
    });

    const tools = captureTools(buildCtx(db));
    const result = tools.get('hub_register')!({ cwd: 'F:\\rts\\proj' }) as { content: { text: string }[] };

    expect(JSON.parse(result.content[0].text).instanceName).toBe('spawn-smoke2');
    // No spurious cwd-derived default row ("proj") should have been created for this folder.
    expect(instancesRepo.byCwd(db, 'F:\\rts\\proj')).toBeUndefined();
  });

  it('cwd-only call with TWO active named sessions sharing that cwd is ambiguous -> falls through to the cwd default', () => {
    const db = buildDb();
    const now = Date.now();
    const named1 = instancesRepo.upsertNamed(db, { name: 'task-a', cwd: 'F:\\rts\\proj', now });
    const named2 = instancesRepo.upsertNamed(db, { name: 'task-b', cwd: 'F:\\rts\\proj', now });
    sessionsRepo.upsertFromHook(db, {
      sessionId: 'sess-a',
      cwd: 'F:\\rts\\proj',
      transcriptPath: null,
      instanceId: named1.id,
      now,
    });
    sessionsRepo.upsertFromHook(db, {
      sessionId: 'sess-b',
      cwd: 'F:\\rts\\proj',
      transcriptPath: null,
      instanceId: named2.id,
      now,
    });

    const tools = captureTools(buildCtx(db));
    const result = tools.get('hub_register')!({ cwd: 'F:\\rts\\proj' }) as { content: { text: string }[] };

    expect(JSON.parse(result.content[0].text).instanceName).toBe('proj');
  });

  it('cwd-only call with only an ENDED named session in that cwd falls through to the cwd default', () => {
    const db = buildDb();
    const now = Date.now();
    const named = instancesRepo.upsertNamed(db, { name: 'spawn-smoke2', cwd: 'F:\\rts\\proj', now });
    sessionsRepo.upsertFromHook(db, {
      sessionId: 'sess-1',
      cwd: 'F:\\rts\\proj',
      transcriptPath: null,
      instanceId: named.id,
      now,
    });
    sessionsRepo.setStatus(db, 'sess-1', 'ended', now);

    const tools = captureTools(buildCtx(db));
    const result = tools.get('hub_register')!({ cwd: 'F:\\rts\\proj' }) as { content: { text: string }[] };

    expect(JSON.parse(result.content[0].text).instanceName).toBe('proj');
  });

  it('an explicit name still wins over an active named session in the same cwd', () => {
    const db = buildDb();
    const now = Date.now();
    const named = instancesRepo.upsertNamed(db, { name: 'spawn-smoke2', cwd: 'F:\\rts\\proj', now });
    sessionsRepo.upsertFromHook(db, {
      sessionId: 'sess-1',
      cwd: 'F:\\rts\\proj',
      transcriptPath: null,
      instanceId: named.id,
      now,
    });

    const tools = captureTools(buildCtx(db));
    const result = tools.get('hub_register')!({ cwd: 'F:\\rts\\proj', name: 'other-task' }) as {
      content: { text: string }[];
    };

    expect(JSON.parse(result.content[0].text).instanceName).toBe('other-task');
  });

  it('a bound session_id still wins over the active-named-session tier', () => {
    const db = buildDb();
    const now = Date.now();
    const boundNamed = instancesRepo.upsertNamed(db, { name: 'bound-task', cwd: 'F:\\rts\\proj', now });
    const otherNamed = instancesRepo.upsertNamed(db, { name: 'other-task', cwd: 'F:\\rts\\proj', now });
    sessionsRepo.upsertFromHook(db, {
      sessionId: 'sess-bound',
      cwd: 'F:\\rts\\proj',
      transcriptPath: null,
      instanceId: boundNamed.id,
      now,
    });
    sessionsRepo.upsertFromHook(db, {
      sessionId: 'sess-other',
      cwd: 'F:\\rts\\proj',
      transcriptPath: null,
      instanceId: otherNamed.id,
      now,
    });

    const tools = captureTools(buildCtx(db));
    const result = tools.get('hub_register')!(
      { cwd: 'F:\\rts\\proj', session_id: 'sess-bound' },
      { sessionId: 'mcp-test' }
    ) as { content: { text: string }[] };

    // Even though 'sess-other' also makes the cwd ambiguous for the tier-3 lookup, the bound
    // session_id (tier 2) is checked first and short-circuits before tier 3 ever runs.
    expect(JSON.parse(result.content[0].text).instanceName).toBe('bound-task');
  });
});

describe('chat_send', () => {
  it('pokes the chat delivery loop on a direct send and on a broadcast', () => {
    const db = buildDb();
    const now = Date.now();
    instancesRepo.upsert(db, { name: 'alpha', cwd: '/alpha', now });
    instancesRepo.upsert(db, { name: 'beta', cwd: '/beta', now });

    const poke = vi.fn();
    const tools = captureTools(buildCtx(db, poke));
    const chatSend = tools.get('chat_send')!;

    chatSend({ to: 'beta', message: 'direct hello', urgent: false });
    expect(poke).toHaveBeenCalledTimes(1);

    chatSend({ message: 'broadcast hello', urgent: false });
    expect(poke).toHaveBeenCalledTimes(2);
  });

  it('does not poke when the recipient is unknown', () => {
    const db = buildDb();
    instancesRepo.upsert(db, { name: 'alpha', cwd: '/alpha', now: Date.now() });

    const poke = vi.fn();
    const tools = captureTools(buildCtx(db, poke));
    const result = tools.get('chat_send')!({ to: 'nobody', message: 'hi', urgent: false }) as {
      isError?: boolean;
    };

    expect(result.isError).toBe(true);
    expect(poke).not.toHaveBeenCalled();
  });

  it('accepts "overlord" as a recipient even though it has no instances row (AI Overlord ask-mode replies)', () => {
    const db = buildDb();
    instancesRepo.upsert(db, { name: 'alpha', cwd: '/alpha', now: Date.now() });

    const poke = vi.fn();
    const tools = captureTools(buildCtx(db, poke));
    const result = tools.get('chat_send')!({ to: 'overlord', message: 'reply to overlord', urgent: false }) as {
      isError?: boolean;
      content: { text: string }[];
    };

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text).to_name).toBe('overlord');
    expect(poke).toHaveBeenCalledTimes(1);
  });

  it('works without a pokeChatDelivery dep (chatDelivery disabled)', () => {
    const db = buildDb();
    instancesRepo.upsert(db, { name: 'alpha', cwd: '/alpha', now: Date.now() });

    const tools = captureTools(buildCtx(db, undefined));
    expect(() => tools.get('chat_send')!({ message: 'no poke wired', urgent: false })).not.toThrow();
  });
});

describe('hub_set_url', () => {
  it('persists a valid http(s) url onto the caller\'s instance', () => {
    const db = buildDb();
    instancesRepo.upsert(db, { name: 'alpha', cwd: '/alpha', now: Date.now() });

    const tools = captureTools(buildCtx(db));
    const result = tools.get('hub_set_url')!({ url: 'http://localhost:5173' }) as { content: { text: string }[] };
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true, url: 'http://localhost:5173' });

    const instance = instancesRepo.byCwd(db, '/alpha');
    expect(instance?.app_url).toBe('http://localhost:5173');
    expect(instance?.app_url_at).toEqual(expect.any(Number));
  });

  it('also upserts an instance_apps row keyed by the url\'s host:port', () => {
    const db = buildDb();
    const instance = instancesRepo.upsert(db, { name: 'alpha', cwd: '/alpha', now: Date.now() });

    const tools = captureTools(buildCtx(db));
    tools.get('hub_set_url')!({ url: 'http://localhost:5173' });

    const apps = instanceAppsRepo.listForInstance(db, instance.id);
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({ label: 'localhost:5173', url: 'http://localhost:5173' });
  });

  it('errors when not registered', () => {
    const db = buildDb();
    const tools = captureTools({
      db,
      bus: new HubBus(),
      log: silentLogger(),
      athen: createAthen({ db, log: silentLogger() }),
      getIdentity: () => undefined,
      bind: () => {},
    });

    const result = tools.get('hub_set_url')!({ url: 'http://localhost:5173' }) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it('rejects a non-http(s) url', () => {
    const db = buildDb();
    instancesRepo.upsert(db, { name: 'alpha', cwd: '/alpha', now: Date.now() });

    const tools = captureTools(buildCtx(db));
    const result = tools.get('hub_set_url')!({ url: 'javascript:alert(1)' }) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('http://');

    expect(instancesRepo.byCwd(db, '/alpha')?.app_url).toBeNull();
  });
});

describe('hub_set_apps', () => {
  it('replaces the caller\'s app list with web (url) and desktop (no url) entries', () => {
    const db = buildDb();
    const instance = instancesRepo.upsert(db, { name: 'alpha', cwd: '/alpha', now: Date.now() });

    const tools = captureTools(buildCtx(db));
    const result = tools.get('hub_set_apps')!({
      apps: [
        { label: 'localhost:5173', url: 'http://localhost:5173' },
        { label: 'desktop app' },
      ],
    }) as { content: { text: string }[] };
    expect(JSON.parse(result.content[0].text).ok).toBe(true);

    const apps = instanceAppsRepo.listForInstance(db, instance.id);
    expect(apps).toHaveLength(2);
    expect(apps.find((a) => a.label === 'desktop app')?.url).toBeNull();
    expect(apps.find((a) => a.label === 'localhost:5173')?.url).toBe('http://localhost:5173');
  });

  it('an empty array clears the caller\'s app list', () => {
    const db = buildDb();
    const instance = instancesRepo.upsert(db, { name: 'alpha', cwd: '/alpha', now: Date.now() });
    instanceAppsRepo.upsert(db, instance.id, 'old', 'http://old', Date.now());

    const tools = captureTools(buildCtx(db));
    tools.get('hub_set_apps')!({ apps: [] });

    expect(instanceAppsRepo.listForInstance(db, instance.id)).toEqual([]);
  });

  it('rejects a non-http(s) url without touching the stored list', () => {
    const db = buildDb();
    const instance = instancesRepo.upsert(db, { name: 'alpha', cwd: '/alpha', now: Date.now() });

    const tools = captureTools(buildCtx(db));
    const result = tools.get('hub_set_apps')!({ apps: [{ label: 'bad', url: 'javascript:alert(1)' }] }) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('http://');
    expect(instanceAppsRepo.listForInstance(db, instance.id)).toEqual([]);
  });

  it('errors when not registered', () => {
    const db = buildDb();
    const tools = captureTools({
      db,
      bus: new HubBus(),
      log: silentLogger(),
      athen: createAthen({ db, log: silentLogger() }),
      getIdentity: () => undefined,
      bind: () => {},
    });

    const result = tools.get('hub_set_apps')!({ apps: [] }) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});

describe('athen tools', () => {
  it('registers athen_save/athen_search/athen_get and no kb_* names', () => {
    const tools = captureTools(buildCtx(buildDb()));

    expect(tools.has('athen_save')).toBe(true);
    expect(tools.has('athen_search')).toBe(true);
    expect(tools.has('athen_get')).toBe(true);
    expect([...tools.keys()].filter((name) => name.startsWith('kb_'))).toEqual([]);
  });

  it('saves and finds a note through the tool handlers (FTS path, no embedder)', async () => {
    const tools = captureTools(buildCtx(buildDb()));

    const saved = (await tools.get('athen_save')!({
      title: 'Build iOS apps',
      body: 'xcodebuild and signing steps',
      tags: 'ios build',
    })) as { content: { text: string }[] };
    const note = JSON.parse(saved.content[0].text) as { id: number; author_name: string };
    expect(note.author_name).toBe('alpha');

    const searched = (await tools.get('athen_search')!({ query: 'ios', limit: 5 })) as {
      content: { text: string }[];
    };
    const { results, count } = JSON.parse(searched.content[0].text) as { results: { id: number }[]; count: number };
    expect(count).toBe(1);
    expect(results[0].id).toBe(note.id);

    const got = (await tools.get('athen_get')!({ id: note.id })) as { content: { text: string }[] };
    expect(JSON.parse(got.content[0].text).body).toBe('xcodebuild and signing steps');
  });

  it('athen_save is fail-soft when the embedder throws: note saved, no error surfaced', async () => {
    const throwing: Embedder = {
      model: 'test-model',
      embed: async () => {
        throw new Error('onnx exploded');
      },
    };
    const tools = captureTools(buildCtx(buildDb(), undefined, throwing));

    const saved = (await tools.get('athen_save')!({ title: 'still saved', body: 'body', tags: '' })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(saved.isError).toBeUndefined();
    expect(JSON.parse(saved.content[0].text).title).toBe('still saved');
  });
});
