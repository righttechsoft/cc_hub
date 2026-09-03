// Mobile API (/api/v1/*). Bearer-auth is applied by app.ts; this file only implements the
// REST surface described in the plan's "Mobile API" section.
import { Hono, type Context } from 'hono';
import { statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import type {
  HubConfig,
  IAttachRegistry,
  IClaudeRunner,
  ILimitWatcher,
  IPromptDelivery,
  LimitStateName,
  Logger,
  PermissionStatus,
  RenameBindingSource,
} from '../types.js';
import type { HubBus } from '../core/bus.js';
import { applyInstanceRename, INSTANCE_NAME_RE } from '../core/identity.js';
import * as instanceAppsRepo from '../db/repo/instanceApps.js';
import * as instancesRepo from '../db/repo/instances.js';
import * as sessionsRepo from '../db/repo/sessions.js';
import * as promptsRepo from '../db/repo/prompts.js';
import * as eventsRepo from '../db/repo/events.js';
import * as messagesRepo from '../db/repo/messages.js';
import * as kbRepo from '../db/repo/kb.js';
import * as permissionsRepo from '../db/repo/permissions.js';
import * as limitRepo from '../db/repo/limit.js';
import * as pushTokensRepo from '../db/repo/pushTokens.js';
import type { Athen } from '../kb/athen.js';
import type { Overlord } from '../overlord/overlord.js';
import type { Dispatcher, DispatchAction } from '../spawn/dispatcher.js';
import { readTranscript } from './transcriptRead.js';
import {
  newestSessionPerCwd,
  renderErrorFragment,
  renderInstanceApps,
  renderKbEditorEmpty,
  renderKbForm,
  renderKbList,
  renderKbSearchResults,
  renderMessagesList,
  renderOverlordAnswer,
  renderOverlordConfirm,
  renderOverlordDispatched,
  renderOverlordDispatchConfirm,
  renderOverlordReplies,
  renderOverlordSent,
  renderSessionsList,
} from './adminUi.js';

// RenameBindingSource now lives in types.js (src/core/identity.ts's applyInstanceRename needs it
// too, for session-name adoption) — re-exported here for backward compatibility with existing
// imports of this module.
export type { RenameBindingSource } from '../types.js';

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
  // orchestrator: pass attach into buildApiRoutes
  attach: IAttachRegistry;
  // Optional: AI Overlord (natural-language questions over past sessions, admin page tab). Absent
  // when config.overlord.enabled is false — the fragment route then returns a plain error fragment.
  overlord?: Overlord;
  // Optional: executes an AI Overlord dispatch-mode plan (inject into an idle attached terminal,
  // or open a new one) once a human confirms it. Absent when config.terminalSpawn.enabled is
  // false — the dispatch route then returns a plain error fragment.
  dispatcher?: Dispatcher;
  // Optional: lets admin-page instance rename (below) also update any live hub_register binding
  // for the renamed instance, so an already-registered MCP session's chat_send/hub_set_url calls
  // keep resolving to the right (renamed) row without needing to call hub_register again.
  gateway?: RenameBindingSource;
}

// Mirrors the admin overlord form's own field cap — defense in depth against a hand-crafted
// oversized request bypassing the client.
const MAX_OVERLORD_QUESTION_LENGTH = 500;
// Mirrors chat_send's own message cap (src/mcp/tools.ts) — an overlord-composed message rides the
// same delivery machinery as any other chat message.
const MAX_OVERLORD_MESSAGE_LENGTH = 4000;
// Appended to every ask-mode message so the recipient agent knows how to reply — 'overlord' has no
// instances row (see RESERVED_RECIPIENTS in src/mcp/tools.ts), so without this hint an agent would
// have no way to know a reply back to the sender is even possible via chat_send.
const OVERLORD_REPLY_HINT = "\n\n(Reply via cc-hub chat_send with to='overlord'.)";
// Mirrors the mobile API's own prompt cap (POST /sessions etc.) — a dispatched task rides the same
// injection/spawn path as any other prompt, so it's held to the same size limit.
const MAX_OVERLORD_TASK_LENGTH = 8000;

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

// Decoded image size cap — generous enough for a compressed phone photo, small enough to keep a
// base64 body (~1.33x on the wire) well under typical body-size limits and away from pathological
// memory use decoding on the hub.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const DEFAULT_IMAGE_EXT = 'png';
const IMAGE_EXT_RE = /^[a-z0-9]{1,8}$/i;

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

// htmx form submissions arrive as application/x-www-form-urlencoded (or multipart), not JSON —
// Hono's parseBody() gives back string | File per field; the admin fragment routes only ever want
// the string, so non-string (a stray File) just reads as empty rather than throwing.
function formStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function buildApiRoutes(deps: BuildApiRoutesDeps): Hono {
  const { config, db, bus, log, delivery, watcher, runner, athen, startedAt, pokeChatDelivery, attach, overlord, dispatcher, gateway } =
    deps;
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

  // Saves a phone-picked image to a temp file on the PC and returns its path. Sending it is a
  // separate step: the caller composes text + this path into one prompt and posts it through the
  // normal /sessions/:id/prompt endpoint, which already knows how to inject into an attached
  // wrapper or fall back to a headless --resume.
  app.post('/sessions/:id/image', async (c) => {
    const id = c.req.param('id');
    const body = await readJsonBody(c);
    const imageBase64 = body && typeof body.imageBase64 === 'string' ? body.imageBase64 : undefined;
    if (!imageBase64) return badRequest(c, 'imageBase64 is required');

    const extRaw = body && typeof body.ext === 'string' ? body.ext : DEFAULT_IMAGE_EXT;
    if (!IMAGE_EXT_RE.test(extRaw)) return badRequest(c, 'ext must be a short alphanumeric extension');
    const ext = extRaw.toLowerCase();

    const session = sessionsRepo.getJoined(db, id);
    if (!session) return notFound(c, 'session not found');

    let bytes: Buffer;
    try {
      bytes = Buffer.from(imageBase64, 'base64');
    } catch {
      return badRequest(c, 'imageBase64 is not valid base64');
    }
    if (bytes.length === 0) return badRequest(c, 'imageBase64 decoded to zero bytes');
    if (bytes.length > MAX_IMAGE_BYTES) {
      return c.json(
        { error: { code: 'too_large', message: `image exceeds maximum size of ${MAX_IMAGE_BYTES} bytes` } },
        413
      );
    }

    const path = join(tmpdir(), `ccimg_${randomBytes(8).toString('hex')}.${ext}`);
    try {
      writeFileSync(path, bytes);
    } catch (err) {
      log.error('apiRoutes: failed to write attached image', {
        sessionId: id,
        error: err instanceof Error ? err.message : String(err),
      });
      return serverError(c, err);
    }

    return c.json({ path });
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

  // Deleting a message stops it being re-delivered: an unread broadcast would otherwise keep
  // reaching instances that haven't read it yet (chatDelivery / UserPromptSubmit injection /
  // urgent Stop block all key off unread rows).
  app.delete('/messages/:id', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return badRequest(c, 'invalid message id');

    const deleted = messagesRepo.remove(db, id);
    if (!deleted) return notFound(c, 'message not found');
    return c.json({ deleted: true });
  });

  app.get('/kb', (c) => {
    const limit = clamp(parseIntWithDefault(c.req.query('limit'), 50), 1, 200);
    const notes = kbRepo.listRecent(db, limit);
    return c.json({ notes });
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

  app.put('/kb/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return badRequest(c, 'invalid kb id');

    const body = await readJsonBody(c);
    const title = body && typeof body.title === 'string' ? body.title : undefined;
    const kbBody = body && typeof body.body === 'string' ? body.body : undefined;
    const tags = body && typeof body.tags === 'string' ? body.tags : undefined;
    if (title === undefined && kbBody === undefined && tags === undefined) {
      return badRequest(c, 'at least one of title, body, tags is required');
    }

    const note = await athen.update(id, { title, body: kbBody, tags });
    if (!note) return notFound(c, 'kb note not found');
    return c.json({ note });
  });

  app.delete('/kb/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return badRequest(c, 'invalid kb id');

    const deleted = await athen.remove(id);
    if (!deleted) return notFound(c, 'kb note not found');
    return c.json({ deleted: true });
  });

  // --- Admin fragment routes (htmx) ---
  // Thin wrappers over the same kb/messages repo + Athen calls as the JSON routes above, but
  // returning HTML fragments for the htmx-driven /admin page (see adminUi.ts) instead of JSON.
  // Mounted under /api/v1 like everything else in this file, so they're bearer-authed by app.ts
  // and relay-forwardable — the /admin page itself is neither, but these calls it makes are.
  app.get('/admin/kb-list', (c) => {
    const limit = clamp(parseIntWithDefault(c.req.query('limit'), 100), 1, 200);
    return c.html(renderKbList(kbRepo.listRecent(db, limit)));
  });

  app.get('/admin/kb-search', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (q.length === 0) return c.html(renderKbList(kbRepo.listRecent(db, 100)));

    const limit = clamp(parseIntWithDefault(c.req.query('limit'), 50), 1, 200);
    const results = await athen.search(q, limit);
    return c.html(renderKbSearchResults(results));
  });

  app.get('/admin/kb-new', (c) => {
    return c.html(renderKbForm({ title: '', tags: '', body: '', isNew: true }));
  });

  app.get('/admin/kb-edit/:id', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.html(renderErrorFragment('Invalid note id.'), 400);

    const note = kbRepo.get(db, id);
    if (!note) return c.html(renderErrorFragment('Note not found.'), 404);

    return c.html(
      renderKbForm({
        id: note.id,
        title: note.title,
        tags: note.tags,
        body: note.body,
        authorName: note.author_name,
        updatedAt: note.updated_at,
        isNew: false,
      })
    );
  });

  app.post('/admin/kb', async (c) => {
    const form = await c.req.parseBody();
    const title = formStr(form.title).trim();
    const tags = formStr(form.tags);
    const body = formStr(form.body);
    if (!title || !body) {
      return c.html(renderKbForm({ title, tags, body, isNew: true, error: 'Title and body are required.' }), 400);
    }

    const note = await athen.save({ title, body, tags, author: 'admin' });
    c.header('HX-Trigger', 'kb-changed');
    return c.html(
      renderKbForm({
        id: note.id,
        title: note.title,
        tags: note.tags,
        body: note.body,
        authorName: note.author_name,
        updatedAt: note.updated_at,
        isNew: false,
      })
    );
  });

  app.put('/admin/kb/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.html(renderErrorFragment('Invalid note id.'), 400);

    const form = await c.req.parseBody();
    const title = formStr(form.title).trim();
    const tags = formStr(form.tags);
    const body = formStr(form.body);
    if (!title || !body) {
      return c.html(
        renderKbForm({ id, title, tags, body, isNew: false, error: 'Title and body are required.' }),
        400
      );
    }

    const note = await athen.update(id, { title, body, tags });
    if (!note) return c.html(renderErrorFragment('Note not found (it may already have been deleted).'), 404);

    c.header('HX-Trigger', 'kb-changed');
    return c.html(
      renderKbForm({
        id: note.id,
        title: note.title,
        tags: note.tags,
        body: note.body,
        authorName: note.author_name,
        updatedAt: note.updated_at,
        isNew: false,
      })
    );
  });

  app.delete('/admin/kb/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.html(renderErrorFragment('Invalid note id.'), 400);

    const deleted = await athen.remove(id);
    if (!deleted) return c.html(renderErrorFragment('Note not found (already deleted?).'), 404);

    c.header('HX-Trigger', 'kb-changed');
    return c.html(renderKbEditorEmpty());
  });

  // Live sessions (everything not 'ended'), newest activity first, decorated with the attach
  // registry's live-terminal + working flags. Shared by the GET route below (polled every 5s) and
  // the rename route further down (so a rename's response can refresh the list in place without
  // waiting for the next poll tick). Optional folder= substring-filters (case-insensitive) on cwd.
  // Attach flags apply only to the newest session per cwd — a cc-attach wrapper is one-per-cwd
  // (well, per resolved NAME — see src/attach/attachRegistry.ts — the folder-level LIVE badge
  // still applies to the newest session in the directory), so an older lingering row in the same
  // directory (e.g. a session whose terminal closed without a SessionEnd hook) must not show LIVE.
  function buildSessionsListHtml(folder: string): string {
    const rows = sessionsRepo.listJoined(db, { status: ['active', 'idle', 'interrupted', 'continuing'] });
    const newest = newestSessionPerCwd(rows);
    let sessions = rows.map((s) => ({
      id: s.id,
      instance_id: s.instance_id,
      instance_name: s.instance_name,
      cwd: s.cwd,
      status: s.status,
      last_event_at: s.last_event_at,
      last_prompt: s.last_prompt,
      attached: newest.has(s.id) && attach.get(s.cwd) !== undefined,
      working: newest.has(s.id) && attach.isWorking(s.cwd),
      session_name: s.session_name,
    }));
    if (folder) sessions = sessions.filter((s) => s.cwd.toLowerCase().includes(folder));
    return renderSessionsList(sessions);
  }

  app.get('/admin/sessions-list', (c) => {
    const folder = (c.req.query('folder') ?? '').trim().toLowerCase();
    return c.html(buildSessionsListHtml(folder));
  });

  // Rename a running instance from the admin page — no restart of its terminal required. Updates
  // the durable `instances.name` row plus the two pieces of live in-memory state that are keyed by
  // name: the attach registry's client slot (src/attach/attachRegistry.ts's `rename`) and any
  // still-open hub_register MCP binding (src/mcp/server.ts's `renameBinding`) — both no-ops if
  // nothing is currently live under the old name. A NAMED terminal's own CC_HUB_NAME env is NOT
  // updated by this (it's an env var baked into an already-running process) — its statusline falls
  // back to a cwd lookup until the terminal is relaunched (see model-statusline.mjs); an UNNAMED
  // terminal has no such caveat since it never depended on the name to begin with.
  app.post('/admin/instances/rename', async (c) => {
    const form = await c.req.parseBody();
    const id = Number(formStr(form.id));
    if (!Number.isInteger(id)) return c.html(renderErrorFragment('Invalid instance id.'), 400);

    const requested = formStr(form.newName).trim().toLowerCase();
    if (!INSTANCE_NAME_RE.test(requested)) {
      return c.html(renderErrorFragment(`Name must match ${INSTANCE_NAME_RE.source} (after lowercasing).`), 400);
    }

    const instance = instancesRepo.byId(db, id);
    if (!instance) return c.html(renderErrorFragment('Instance not found.'), 404);

    const collision = instancesRepo.byName(db, requested);
    if (collision && collision.id !== id) {
      return c.html(renderErrorFragment(`Name "${requested}" is already used by another instance.`), 409);
    }

    if (requested !== instance.name) {
      applyInstanceRename({ db, attach, gateway }, id, instance.name, requested, 'explicit');
    }

    return c.html(buildSessionsListHtml(''));
  });

  // Persistent footer: apps/servers instances have told the hub they're running (via the
  // hub_set_apps/hub_set_url MCP tools, or captured automatically from cc-attach's 'url'
  // output-trigger notice — see app.ts's /attach handler), grouped per instance, most recently
  // updated first. Polled every 15s.
  app.get('/admin/instance-urls', (c) => {
    return c.html(renderInstanceApps(instanceAppsRepo.listAllJoined(db)));
  });

  app.get('/admin/messages-list', (c) => {
    // ?kind=broadcast|direct filters in SQL (a broadcast has no recipient). Filtering a
    // post-limit slice instead once hid every broadcast older than the newest 50 direct
    // messages — the filter must constrain the query itself.
    // Broadcasts are rare and the admin's cleanup target, so they list without paging (high
    // sanity cap only); All/Direct page 50 at a time via beforeId + a Load-more fragment.
    const kind = c.req.query('kind');
    const beforeIdParam = c.req.query('beforeId');
    const beforeId = beforeIdParam !== undefined ? Number(beforeIdParam) : undefined;
    if (beforeId !== undefined && !Number.isInteger(beforeId)) return badRequest(c, 'invalid beforeId');

    if (kind === 'broadcast') {
      return c.html(renderMessagesList(messagesRepo.listByKind(db, 'broadcast', 500)));
    }
    const pageSize = clamp(parseIntWithDefault(c.req.query('limit'), 50), 1, 200);
    const messages =
      kind === 'direct'
        ? messagesRepo.listByKind(db, 'direct', pageSize, beforeId)
        : messagesRepo.listAll(db, pageSize, beforeId);
    return c.html(renderMessagesList(messages, { kind: kind === 'direct' ? 'direct' : undefined, pageSize }));
  });

  app.delete('/admin/messages/:id', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.html(renderErrorFragment('Invalid message id.'), 400);

    const deleted = messagesRepo.remove(db, id);
    if (!deleted) return c.html(renderErrorFragment('Message not found (already deleted?).'), 404);
    // Deleting a message stops it being re-delivered to instances that haven't read it yet (same
    // reasoning as the JSON DELETE /messages/:id route above). The delete button's own hx-target
    // is the message's own card (outerHTML swap), so an empty body here just removes it in place.
    return c.html('');
  });

  // AI Overlord: natural-language question over past sessions, a message to send live instances
  // directly, OR a task to dispatch to a project (admin page's "AI Overlord" tab). Same htmx-
  // fragment pattern as the other /admin/* routes above — form field, not JSON. Ask/dispatch modes
  // never act here — they only render a confirmation (renderOverlordConfirm /
  // renderOverlordDispatchConfirm); the actual send/dispatch happens from a second, explicit human
  // click (POST overlord-send / POST overlord-dispatch below).
  app.post('/admin/overlord-ask', async (c) => {
    const form = await c.req.parseBody();
    const q = formStr(form.q).trim().slice(0, MAX_OVERLORD_QUESTION_LENGTH);
    if (!q) return c.html(renderErrorFragment('Ask a question first.'), 400);
    if (!overlord) return c.html(renderErrorFragment('Overlord disabled'), 503);

    try {
      const result = await overlord.ask(q);
      if (result.mode === 'ask') {
        return c.html(renderOverlordConfirm(result.message, result.targets, result.excluded));
      }
      if (result.mode === 'dispatch') {
        return c.html(renderOverlordDispatchConfirm(result));
      }
      return c.html(renderOverlordAnswer(result));
    } catch (err) {
      log.error('apiRoutes: overlord.ask failed', { error: err instanceof Error ? err.message : String(err) });
      return c.html(renderErrorFragment('Overlord failed to answer — see hub logs.'), 500);
    }
  });

  // AI Overlord ask-mode confirmation's Send button. Inserts one DIRECT message per target,
  // from_name='overlord' (the reserved sender — see RESERVED_RECIPIENTS in src/mcp/tools.ts; no
  // instances row, so chatDelivery's instancesRepo.list()-driven loop can never target it), through
  // exactly the same insert+poke path POST /api/v1/messages uses. Unknown targets (an instance that
  // vanished between the confirm render and the click) are skipped, not fatal.
  app.post('/admin/overlord-send', async (c) => {
    if (!overlord) return c.html(renderErrorFragment('Overlord disabled'), 503);

    const form = await c.req.parseBody({ all: true });
    const messageField = form.message;
    const message = formStr(Array.isArray(messageField) ? messageField[0] : messageField)
      .trim()
      .slice(0, MAX_OVERLORD_MESSAGE_LENGTH);
    const targetsField = form.targets;
    const targetNames = (Array.isArray(targetsField) ? targetsField : targetsField !== undefined ? [targetsField] : [])
      .map((t) => formStr(t).trim())
      .filter((t) => t.length > 0);

    if (!message) return c.html(renderErrorFragment('Message is empty.'), 400);
    if (targetNames.length === 0) return c.html(renderErrorFragment('No targets selected.'), 400);

    // Captured BEFORE inserting — the replies poll only ever wants messages that arrived after
    // this send, not the send's own rows (also addressed via to_name, but from 'overlord', not to
    // it) or anything older.
    const sinceId = messagesRepo.maxId(db);
    const body = message + OVERLORD_REPLY_HINT;

    const sentTo: string[] = [];
    for (const name of targetNames) {
      if (!instancesRepo.byName(db, name)) {
        log.warn('apiRoutes: overlord-send skipped unknown target', { name });
        continue;
      }
      const sent = messagesRepo.send(db, { from: 'overlord', to: name, body, urgent: false, now: Date.now() });
      bus.emit({ type: 'message', message: sent });
      sentTo.push(name);
    }

    if (sentTo.length === 0) {
      return c.html(renderErrorFragment('None of the selected targets are known instances anymore.'), 409);
    }

    pokeChatDelivery?.();
    return c.html(renderOverlordSent(sentTo, sinceId));
  });

  // AI Overlord dispatch-mode confirmation's Dispatch button. Re-validates the plan (it can go
  // stale — the human may take a while to click, or the target terminal may have closed) rather
  // than trusting the hidden form fields blindly: name format, cwd still exists, and for an
  // 'inject' plan that a client is still attached under that name (else transparently fall back to
  // spawning a fresh tab instead of failing outright). Gated on the dispatcher dep AND
  // config.terminalSpawn.enabled being present, same pattern as the other overlord routes above.
  app.post('/admin/overlord-dispatch', async (c) => {
    if (!dispatcher || !config.terminalSpawn.enabled) {
      return c.html(renderErrorFragment('Terminal dispatch disabled'), 503);
    }

    const form = await c.req.parseBody();
    const actionKind = formStr(form.action).trim();
    const name = formStr(form.name).trim().toLowerCase();
    const cwd = formStr(form.cwd).trim();
    const task = formStr(form.task).trim().slice(0, MAX_OVERLORD_TASK_LENGTH);

    if (actionKind !== 'inject' && actionKind !== 'spawn') {
      return c.html(renderErrorFragment('Invalid dispatch action.'), 400);
    }
    if (!INSTANCE_NAME_RE.test(name)) return c.html(renderErrorFragment('Invalid instance name.'), 400);
    if (!task) return c.html(renderErrorFragment('Task is empty.'), 400);

    try {
      const st = statSync(cwd);
      if (!st.isDirectory()) return c.html(renderErrorFragment('Target folder no longer exists.'), 400);
    } catch {
      return c.html(renderErrorFragment('Target folder no longer exists.'), 400);
    }

    const stillAttached = attach.getByName ? attach.getByName(name) !== undefined : attach.get(cwd) !== undefined;
    const action: DispatchAction =
      actionKind === 'inject' && stillAttached ? { kind: 'inject', name, cwd } : { kind: 'spawn', name, cwd };

    try {
      const result = await dispatcher.dispatch(action, task);
      return c.html(renderOverlordDispatched(result.via, name, cwd, task));
    } catch (err) {
      log.error('apiRoutes: overlord dispatch failed', { error: err instanceof Error ? err.message : String(err) });
      return c.html(renderErrorFragment('Dispatch failed — see hub logs.'), 500);
    }
  });

  // Polled by the div renderOverlordSent renders (every 3s) — replies are direct messages addressed
  // to the reserved 'overlord' recipient. Marks each rendered message read with reader 'overlord'
  // (INSERT OR IGNORE, via=NULL): this writer only ever touches to_name='overlord' rows, a namespace
  // no other mark_read writer reads from, so it cannot collide with chatDelivery's via-tagging (see
  // the mark_read gotcha in CLAUDE.md).
  app.get('/admin/overlord-replies', (c) => {
    const afterId = parseIntWithDefault(c.req.query('afterId'), 0);
    const replies = messagesRepo.listToOverlordAfter(db, afterId);
    if (replies.length > 0) {
      messagesRepo.markRead(
        db,
        replies.map((m) => m.id),
        'overlord',
        Date.now()
      );
    }
    return c.html(renderOverlordReplies(replies));
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
