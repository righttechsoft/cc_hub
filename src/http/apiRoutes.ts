// Mobile API (/api/v1/*). Bearer-auth is applied by app.ts; this file only implements the
// REST surface described in the plan's "Mobile API" section.
import { Hono, type Context } from 'hono';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type Database from 'better-sqlite3';
import type {
  HubConfig,
  IClaudeRunner,
  ILimitWatcher,
  IPromptDelivery,
  LimitStateName,
  Logger,
  PermissionStatus,
} from '../types.js';
import type { HubBus } from '../core/bus.js';
import * as sessionsRepo from '../db/repo/sessions.js';
import * as promptsRepo from '../db/repo/prompts.js';
import * as eventsRepo from '../db/repo/events.js';
import * as messagesRepo from '../db/repo/messages.js';
import * as kbRepo from '../db/repo/kb.js';
import * as permissionsRepo from '../db/repo/permissions.js';
import * as limitRepo from '../db/repo/limit.js';
import * as pushTokensRepo from '../db/repo/pushTokens.js';
import type { Athen } from '../kb/athen.js';
import { readTranscript } from './transcriptRead.js';

export interface BuildApiRoutesDeps {
  config: HubConfig;
  db: Database.Database;
  bus: HubBus;
  log: Logger;
  delivery: IPromptDelivery;
  watcher: ILimitWatcher | undefined;
  runner: IClaudeRunner;
  athen: Athen;
  startedAt: number;
  // Optional: nudges the idle chat delivery loop so a mobile-sent message reaches idle recipients
  // immediately instead of waiting for the next poll tick.
  pokeChatDelivery?: () => void;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function badRequest(c: Context, message: string): Response {
  return c.json({ error: { code: 'bad_request', message } }, 400);
}

function notFound(c: Context, message: string): Response {
  return c.json({ error: { code: 'not_found', message } }, 404);
}

function conflict(c: Context, message: string): Response {
  return c.json({ error: { code: 'conflict', message } }, 409);
}

function serverError(c: Context, err: unknown): Response {
  return c.json(
    { error: { code: 'internal_error', message: err instanceof Error ? err.message : String(err) } },
    500
  );
}

function parseOptionalInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) ? n : undefined;
}

function parseIntWithDefault(raw: string | undefined, fallback: number): number {
  return parseOptionalInt(raw) ?? fallback;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

const PERMISSION_STATUSES: readonly PermissionStatus[] = ['pending', 'allowed', 'denied', 'timeout'];
function isPermissionStatus(v: string | undefined): v is PermissionStatus {
  return v !== undefined && (PERMISSION_STATUSES as readonly string[]).includes(v);
}

// Mirrors the MCP chat_send tool's cap (src/mcp/tools.ts) — keeps a mobile-submitted prompt
// well clear of Windows' ~32K argv length limit once ClaudeRunner passes it as a spawn argument.
const MAX_PROMPT_LENGTH = 8000;

const LIMIT_STATE_NAMES: readonly LimitStateName[] = ['ok', 'limited', 'waiting_reset', 'continuing', 'unknown'];
function isLimitStateName(v: unknown): v is LimitStateName {
  return typeof v === 'string' && (LIMIT_STATE_NAMES as readonly string[]).includes(v);
}

const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const;
function isPermissionMode(v: unknown): v is (typeof PERMISSION_MODES)[number] {
  return typeof v === 'string' && (PERMISSION_MODES as readonly string[]).includes(v);
}

async function readJsonBody(c: Context): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await c.req.json();
    return isRecord(body) ? body : undefined;
  } catch {
    return undefined;
  }
}

export function buildApiRoutes(deps: BuildApiRoutesDeps): Hono {
  const { config, db, bus, log, delivery, watcher, runner, athen, startedAt, pokeChatDelivery } = deps;
  const app = new Hono();

  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      uptimeMs: Date.now() - startedAt,
      limit: limitRepo.getState(db),
    });
  });

  app.post('/sessions', async (c) => {
    const body = await readJsonBody(c);

    const cwd = body && typeof body.cwd === 'string' ? body.cwd : undefined;
    if (!cwd || cwd.length === 0) return badRequest(c, 'cwd is required');

    const prompt = body && typeof body.prompt === 'string' ? body.prompt : undefined;
    if (!prompt || prompt.length === 0) return badRequest(c, 'prompt is required');
    if (prompt.length > MAX_PROMPT_LENGTH) {
      return badRequest(c, `prompt exceeds maximum length of ${MAX_PROMPT_LENGTH} characters`);
    }

    const permissionModeRaw = body?.permissionMode;
    if (permissionModeRaw !== undefined && !isPermissionMode(permissionModeRaw)) {
      return badRequest(c, `permissionMode must be one of ${PERMISSION_MODES.join('|')}`);
    }
    const permissionMode = permissionModeRaw as (typeof PERMISSION_MODES)[number] | undefined;

    if (!isAbsolute(cwd)) return badRequest(c, 'cwd must be an absolute path');

    try {
      const stat = statSync(cwd);
      if (!stat.isDirectory()) return badRequest(c, 'cwd is not a directory');
    } catch {
      return badRequest(c, 'cwd does not exist');
    }

    if (runner.atCapacity()) {
      return conflict(c, 'runner at max concurrent sessions');
    }

    runner
      .startNew({ cwd, prompt, permissionMode })
      .then((result) => {
        if (result.code !== 0) {
          log.warn('apiRoutes: startNew exited non-zero', { cwd, code: result.code, stderr: result.stderr });
        } else {
          log.info('apiRoutes: startNew completed', { cwd, code: result.code });
        }
      })
      .catch((err: unknown) => {
        log.warn('apiRoutes: startNew failed', { cwd, error: err instanceof Error ? err.message : String(err) });
      });

    return c.json({ spawned: true }, 202);
  });

  app.get('/sessions', (c) => {
    const statusParam = c.req.query('status');
    const statuses = statusParam
      ? statusParam
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : undefined;
    const sessions = sessionsRepo.listJoined(db, statuses && statuses.length > 0 ? { status: statuses } : undefined);
    return c.json({ sessions });
  });

  app.get('/sessions/:id', (c) => {
    const id = c.req.param('id');
    const session = sessionsRepo.getJoined(db, id);
    if (!session) return notFound(c, 'session not found');

    const pendingPrompts = promptsRepo.listForSession(db, id);
    const events = eventsRepo.recent(db, id, 20);
    return c.json({ session, pendingPrompts, events });
  });

  app.get('/sessions/:id/events', (c) => {
    const id = c.req.param('id');
    const session = sessionsRepo.get(db, id);
    if (!session) return notFound(c, 'session not found');

    const afterId = parseIntWithDefault(c.req.query('afterId'), 0);
    const limit = clamp(parseIntWithDefault(c.req.query('limit'), 100), 1, 500);
    const events = eventsRepo.listBySession(db, id, afterId, limit);
    return c.json({ events });
  });

  app.get('/sessions/:id/transcript', async (c) => {
    const id = c.req.param('id');
    const session = sessionsRepo.get(db, id);
    if (!session) return notFound(c, 'session not found');
    if (!session.transcript_path) {
      return c.json({ error: { code: 'no_transcript', message: 'session has no transcript' } }, 409);
    }

    const afterByteRaw = parseOptionalInt(c.req.query('afterByte'));
    const afterByte = afterByteRaw !== undefined && afterByteRaw >= 0 ? afterByteRaw : undefined;
    const tailBytes = clamp(parseIntWithDefault(c.req.query('tailBytes'), 262144), 16384, 1048576);

    try {
      const result = await readTranscript(session.transcript_path, { afterByte, tailBytes });
      return c.json(result);
    } catch (err) {
      return c.json(
        { error: { code: 'no_transcript', message: err instanceof Error ? err.message : String(err) } },
        409
      );
    }
  });

  app.post('/sessions/:id/prompt', async (c) => {
    const id = c.req.param('id');
    const body = await readJsonBody(c);
    const prompt = body && typeof body.prompt === 'string' ? body.prompt : undefined;
    if (!prompt || prompt.length === 0) return badRequest(c, 'prompt is required');
    if (prompt.length > MAX_PROMPT_LENGTH) {
      return badRequest(c, `prompt exceeds maximum length of ${MAX_PROMPT_LENGTH} characters`);
    }

    const session = sessionsRepo.get(db, id);
    if (!session || session.status === 'ended') {
      return conflict(c, 'session has ended or does not exist');
    }

    try {
      const result = await delivery.send(id, prompt, 'mobile');
      return c.json(result);
    } catch (err) {
      log.error('apiRoutes: delivery.send failed', { sessionId: id, error: err instanceof Error ? err.message : String(err) });
      return serverError(c, err);
    }
  });

  app.post('/sessions/:id/auto-continue', async (c) => {
    const id = c.req.param('id');
    const body = await readJsonBody(c);
    const enabled = body && typeof body.enabled === 'boolean' ? body.enabled : undefined;
    if (enabled === undefined) return badRequest(c, 'enabled (boolean) is required');

    const session = sessionsRepo.get(db, id);
    if (!session) return notFound(c, 'session not found');

    sessionsRepo.setAutoContinue(db, id, enabled);
    return c.json({ id, auto_continue: enabled ? 1 : 0 });
  });

  app.get('/permissions', (c) => {
    const statusParam = c.req.query('status');
    const status = isPermissionStatus(statusParam) ? statusParam : undefined;
    const permissions = permissionsRepo.list(db, status);
    return c.json({ permissions });
  });

  app.post('/permissions/:id/decision', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return badRequest(c, 'invalid permission id');

    const body = await readJsonBody(c);
    const behavior = body && (body.behavior === 'allow' || body.behavior === 'deny') ? body.behavior : undefined;
    if (!behavior) return badRequest(c, 'behavior must be "allow" or "deny"');
    const message = body && typeof body.message === 'string' ? body.message : undefined;

    const decided = permissionsRepo.decide(db, id, {
      status: behavior === 'allow' ? 'allowed' : 'denied',
      message: message ?? null,
      decidedBy: 'mobile',
      now: Date.now(),
    });
    if (!decided) return conflict(c, 'permission already decided or not found');

    bus.emit({ type: 'permission_decided', request: decided });
    return c.json({ permission: decided });
  });

  app.get('/messages', (c) => {
    const limit = clamp(parseIntWithDefault(c.req.query('limit'), 50), 1, 200);
    const beforeId = parseOptionalInt(c.req.query('beforeId'));
    const messages = messagesRepo.listAll(db, limit, beforeId);
    return c.json({ messages });
  });

  app.post('/messages', async (c) => {
    const body = await readJsonBody(c);
    const messageBody = body && typeof body.body === 'string' ? body.body : undefined;
    if (!messageBody) return badRequest(c, 'body is required');
    const to = body && typeof body.to === 'string' && body.to.length > 0 ? body.to : null;
    const urgent = body?.urgent === true;

    const message = messagesRepo.send(db, { from: 'mobile', to, body: messageBody, urgent, now: Date.now() });
    bus.emit({ type: 'message', message });
    pokeChatDelivery?.();
    return c.json({ message }, 201);
  });

  app.get('/kb/search', async (c) => {
    const q = c.req.query('q') ?? '';
    const limit = clamp(parseIntWithDefault(c.req.query('limit'), 5), 1, 50);
    const results = await athen.search(q, limit);
    return c.json({ results });
  });

  app.get('/kb/:id', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return badRequest(c, 'invalid kb id');
    const note = kbRepo.get(db, id);
    if (!note) return notFound(c, 'kb note not found');
    return c.json({ note });
  });

  app.post('/kb', async (c) => {
    const body = await readJsonBody(c);
    const title = body && typeof body.title === 'string' ? body.title : undefined;
    const kbBody = body && typeof body.body === 'string' ? body.body : undefined;
    if (!title || !kbBody) return badRequest(c, 'title and body are required');
    const tags = body && typeof body.tags === 'string' ? body.tags : '';

    const note = await athen.save({ title, body: kbBody, tags, author: 'mobile' });
    return c.json({ note }, 201);
  });

  app.get('/limit', (c) => {
    const state = limitRepo.getState(db);
    const events = limitRepo.listEvents(db, 20);
    return c.json({ state, events });
  });

  app.post('/push/register', async (c) => {
    const body = await readJsonBody(c);
    const token = typeof body?.token === 'string' ? body.token.trim().toLowerCase() : '';
    if (!/^[0-9a-f]{16,200}$/.test(token)) return badRequest(c, 'token must be a hex APNs device token');
    pushTokensRepo.upsert(db, { token, platform: 'ios', now: Date.now() });
    return c.json({ ok: true });
  });

  app.post('/debug/limit', async (c) => {
    if (config.logLevel !== 'debug') return notFound(c, 'not found');
    if (!watcher) return c.json({ error: { code: 'unavailable', message: 'limit watcher is not running' } }, 503);

    const body = await readJsonBody(c);
    const state = body?.state;
    if (!isLimitStateName(state)) {
      return badRequest(c, 'state must be one of ok|limited|waiting_reset|continuing|unknown');
    }
    const resetsAtRaw = body?.resetsAtMs;
    const resetsAtMs = typeof resetsAtRaw === 'number' ? resetsAtRaw : resetsAtRaw === null ? null : undefined;

    watcher.forceState(state, resetsAtMs);
    return c.json({ ok: true });
  });

  return app;
}
