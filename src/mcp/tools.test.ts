import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runMigrations } from '../db/migrations.js';
import { HubBus } from '../core/bus.js';
import * as instancesRepo from '../db/repo/instances.js';
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

  it('works without a pokeChatDelivery dep (chatDelivery disabled)', () => {
    const db = buildDb();
    instancesRepo.upsert(db, { name: 'alpha', cwd: '/alpha', now: Date.now() });

    const tools = captureTools(buildCtx(db, undefined));
    expect(() => tools.get('chat_send')!({ message: 'no poke wired', urgent: false })).not.toThrow();
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
