// Hub's brain: turns Claude Code hook events into DB state, bus fanout and (occasionally)
// stdout that gets injected back into the CC transcript. Contract with the hook script is
// strict: this route ALWAYS answers 200 with `{}` or `{ stdout: string }`, never an error
// status, so a CC session never blocks/degrades on hub trouble (see plan risk "fail-silent").
import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import type {
  HookPayload,
  HubConfig,
  IClaudeRunner,
  ILimitWatcher,
  IPromptDelivery,
  InstanceRow,
  Logger,
  MessageRow,
  PermissionRow,
  PermissionStatus,
  SessionRow,
} from '../types.js';
import type { HubBus } from '../core/bus.js';
import { instanceNameFromCwd } from '../core/identity.js';
import { renderInboxContext, renderSessionStartBanner, renderUrgentBlock } from '../core/messageFormat.js';
import * as instancesRepo from '../db/repo/instances.js';
import * as sessionsRepo from '../db/repo/sessions.js';
import * as messagesRepo from '../db/repo/messages.js';
import * as eventsRepo from '../db/repo/events.js';
import * as permissionsRepo from '../db/repo/permissions.js';

export interface HooksRoutesDeps {
  config: HubConfig;
  db: Database.Database;
  bus: HubBus;
  log: Logger;
  delivery: IPromptDelivery;
  getWatcher: () => ILimitWatcher | undefined;
  runner: IClaudeRunner;
}

interface EventCtx {
  sessionId: string | undefined;
  cwd: string | undefined;
  now: number;
  instanceName: string | null;
}

const RESUME_LOOKBACK_MS = 10 * 60_000;
const PERMISSION_POLL_INTERVAL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// PermissionRequest hook output shape drifts across Claude Code versions (see plan risk #1).
// Kept isolated so a CC upgrade only requires touching this one function, not the long-poll logic.
function composePermissionDecision(status: PermissionStatus, message: string | null): unknown {
  const behavior = status === 'allowed' ? 'allow' : 'deny';
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior,
        // 'message' is only documented for deny (mirrors the SDK PermissionResult shape).
        ...(behavior === 'deny' && message ? { message } : {}),
      },
    },
  };
}

export function buildHooksRoutes(deps: HooksRoutesDeps): Hono {
  const { config, db, bus, log, delivery, getWatcher, runner } = deps;
  const app = new Hono();

  // Per-session throttle for PostToolUse recording; lives for the process lifetime of this route.
  const postToolUseLastRecordedAt = new Map<string, number>();

  function resolveCtx(payload: HookPayload): EventCtx {
    const now = Date.now();
    const sessionId = typeof payload.session_id === 'string' ? payload.session_id : undefined;
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : undefined;

    let instanceName: string | null = null;
    if (cwd) {
      instanceName = instancesRepo.byCwd(db, cwd)?.name ?? null;
    } else if (sessionId) {
      instanceName = sessionsRepo.getJoined(db, sessionId)?.instance_name ?? null;
    }

    return { sessionId, cwd, now, instanceName };
  }

  function ensureInstanceAndSession(payload: HookPayload, now: number): { name: string; inst: InstanceRow; sess: SessionRow } {
    const cwd = String(payload.cwd ?? '');
    const sessionId = String(payload.session_id ?? '');
    const name = instanceNameFromCwd(db, cwd);
    const inst = instancesRepo.upsert(db, { cwd, name, now });
    const sess = sessionsRepo.upsertFromHook(db, {
      sessionId,
      instanceId: inst.id,
      cwd,
      transcriptPath: typeof payload.transcript_path === 'string' ? payload.transcript_path : null,
      now,
    });
    return { name, inst, sess };
  }

  function handleSessionStart(payload: HookPayload): string {
    const now = Date.now();
    const cwd = String(payload.cwd ?? '');
    const { name, sess } = ensureInstanceAndSession(payload, now);

    // Turn hasn't started yet — upsertFromHook's default status doesn't matter, force idle.
    sessionsRepo.setStatus(db, sess.id, 'idle', now);

    if (payload.source === 'resume') {
      const candidates = sessionsRepo.findRecentByCwd(db, cwd, RESUME_LOOKBACK_MS, now);
      const match = candidates.find(
        (candidate) => candidate.id !== sess.id && (runner.isRunning(candidate.id) || candidate.status === 'continuing')
      );
      if (match) {
        sessionsRepo.linkResumedFrom(db, sess.id, match.id);
      }
    }

    eventsRepo.record(db, {
      sessionId: sess.id,
      instanceName: name,
      type: 'SessionStart',
      payload: { source: typeof payload.source === 'string' ? payload.source : null },
      now,
    });
    bus.emit({ type: 'session_status', sessionId: sess.id, status: 'idle' });

    const unread = messagesRepo.unreadFor(db, name).length;
    return renderSessionStartBanner(unread);
  }

  function handleUserPromptSubmit(payload: HookPayload): string | undefined {
    const now = Date.now();
    const promptText = typeof payload.prompt === 'string' ? payload.prompt : '';
    const preview = promptText.slice(0, 500);
    const { name, sess } = ensureInstanceAndSession(payload, now);

    sessionsRepo.setStatus(db, sess.id, 'active', now);
    sessionsRepo.setLastPrompt(db, sess.id, preview);

    eventsRepo.record(db, {
      sessionId: sess.id,
      instanceName: name,
      type: 'UserPromptSubmit',
      payload: { prompt: preview },
      now,
    });
    bus.emit({ type: 'session_status', sessionId: sess.id, status: 'active' });
    bus.emit({ type: 'session_event', sessionId: sess.id, eventType: 'UserPromptSubmit', payload: { prompt: preview }, createdAt: now });

    const unread = messagesRepo.unreadFor(db, name);
    if (unread.length > 0) {
      messagesRepo.markRead(
        db,
        unread.map((m: MessageRow) => m.id),
        name,
        now
      );
      return renderInboxContext(unread);
    }
    return undefined;
  }

  function handleNotification(payload: HookPayload): undefined {
    const { sessionId, now, instanceName } = resolveCtx(payload);
    if (sessionId) {
      sessionsRepo.touchLastEventAt(db, sessionId, now);
      // Current CC sends notification_type (enum), not message; keep message for older versions.
      const notifPayload = {
        notification_type: payload.notification_type ?? null,
        message: payload.message ?? null,
      };
      eventsRepo.record(db, {
        sessionId,
        instanceName,
        type: 'Notification',
        payload: notifPayload,
        now,
      });
      bus.emit({
        type: 'session_event',
        sessionId,
        eventType: 'Notification',
        payload: notifPayload,
        createdAt: now,
      });
    }

    const message = String(payload.message ?? '');
    if (/limit|rate.?limit|resets at/i.test(message)) {
      getWatcher()?.pokeNow();
    }
    return undefined;
  }

  function handleStop(payload: HookPayload): string | undefined {
    const { sessionId, now, instanceName } = resolveCtx(payload);
    if (!sessionId) return undefined;

    // Loop guard: CC sets this when our own prior block already fired for this stop.
    if (payload.stop_hook_active === true) {
      return undefined;
    }

    const claim = delivery.claimForStopBlock(sessionId);
    if (claim) {
      return JSON.stringify({ decision: 'block', reason: claim.reason });
    }

    if (instanceName) {
      const urgent = messagesRepo.urgentUnreadFor(db, instanceName);
      if (urgent.length > 0) {
        messagesRepo.markRead(
          db,
          urgent.map((m: MessageRow) => m.id),
          instanceName,
          now
        );
        return JSON.stringify({ decision: 'block', reason: renderUrgentBlock(urgent) });
      }
    }

    sessionsRepo.setStatus(db, sessionId, 'idle', now);
    eventsRepo.record(db, { sessionId, instanceName, type: 'Stop', payload: null, now });
    bus.emit({ type: 'session_status', sessionId, status: 'idle' });
    return undefined;
  }

  async function handlePermissionRequest(payload: HookPayload): Promise<string | undefined> {
    const { sessionId, now } = resolveCtx(payload);
    if (!sessionId) return undefined;

    sessionsRepo.touchLastEventAt(db, sessionId, now);

    const row: PermissionRow = permissionsRepo.insert(db, {
      sessionId,
      toolName: String(payload.tool_name ?? ''),
      toolInput: JSON.stringify(payload.tool_input ?? null),
      raw: JSON.stringify(payload),
      now,
    });
    bus.emit({ type: 'permission_request', request: row });

    const deadline = now + config.hooks.permissionWaitMs;
    let current: PermissionRow = row;
    while (current.status === 'pending' && Date.now() < deadline) {
      await sleep(PERMISSION_POLL_INTERVAL_MS);
      const latest = permissionsRepo.get(db, row.id);
      if (!latest) break;
      current = latest;
    }

    if (current.status !== 'pending') {
      return JSON.stringify(composePermissionDecision(current.status, current.decision_message));
    }

    const timeoutAt = Date.now();
    permissionsRepo.markTimeout(db, row.id, timeoutAt);
    const finalRow = permissionsRepo.get(db, row.id) ?? { ...current, status: 'timeout' as const, decided_at: timeoutAt };

    // markTimeout is a no-op once the row is no longer 'pending', which happens when a decision
    // lands in the race window between our last poll and the deadline elapsing. In that case
    // finalRow already reflects the real decision (and /decision already emitted
    // 'permission_decided' for it) — honor it instead of reporting a timeout that never happened.
    if (finalRow.status !== 'timeout') {
      return JSON.stringify(composePermissionDecision(finalRow.status, finalRow.decision_message));
    }

    bus.emit({ type: 'permission_decided', request: finalRow });
    return undefined;
  }

  function handlePostToolUse(payload: HookPayload): undefined {
    if (!config.hooks.postToolUse) return undefined;

    const { sessionId, now, instanceName } = resolveCtx(payload);
    if (!sessionId) return undefined;

    const lastRecordedAt = postToolUseLastRecordedAt.get(sessionId) ?? 0;
    if (now - lastRecordedAt < config.hooks.postToolUseThrottleMs) return undefined;
    postToolUseLastRecordedAt.set(sessionId, now);

    const toolInputRaw = JSON.stringify(payload.tool_input ?? null);
    const toolInput = toolInputRaw.length > 2000 ? toolInputRaw.slice(0, 2000) : toolInputRaw;
    const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : null;

    eventsRepo.record(db, {
      sessionId,
      instanceName,
      type: 'PostToolUse',
      payload: { tool_name: toolName, tool_input: toolInput },
      now,
    });
    bus.emit({
      type: 'session_event',
      sessionId,
      eventType: 'PostToolUse',
      payload: { tool_name: toolName },
      createdAt: now,
    });
    return undefined;
  }

  function handleSessionEnd(payload: HookPayload): undefined {
    const { sessionId, now, instanceName } = resolveCtx(payload);
    if (!sessionId) return undefined;

    sessionsRepo.setStatus(db, sessionId, 'ended', now);
    eventsRepo.record(db, { sessionId, instanceName, type: 'SessionEnd', payload: null, now });
    bus.emit({ type: 'session_status', sessionId, status: 'ended' });
    return undefined;
  }

  function handleDefault(payload: HookPayload): undefined {
    const { sessionId, now, instanceName } = resolveCtx(payload);
    if (sessionId) {
      eventsRepo.record(db, {
        sessionId,
        instanceName,
        type: typeof payload.hook_event_name === 'string' ? payload.hook_event_name : 'unknown',
        payload: null,
        now,
      });
    }
    return undefined;
  }

  async function dispatch(payload: HookPayload): Promise<string | undefined> {
    switch (payload.hook_event_name) {
      case 'SessionStart':
        return handleSessionStart(payload);
      case 'UserPromptSubmit':
        return handleUserPromptSubmit(payload);
      case 'Notification':
        return handleNotification(payload);
      case 'Stop':
        return handleStop(payload);
      case 'PermissionRequest':
        return handlePermissionRequest(payload);
      case 'PostToolUse':
        return handlePostToolUse(payload);
      case 'SessionEnd':
        return handleSessionEnd(payload);
      default:
        return handleDefault(payload);
    }
  }

  // NOTE for integrator: PermissionRequest can hold this handler open for up to
  // config.hooks.permissionWaitMs (~30s default) while long-polling for a decision. That's
  // fine under Hono/Node (no blocking of the event loop — it's an async setTimeout poll) but
  // means concurrent PermissionRequest hooks each occupy their own in-flight request/promise.
  app.post('/event', async (c) => {
    try {
      const payload = await c.req.json<HookPayload>();
      const stdout = await dispatch(payload);
      return stdout !== undefined ? c.json({ stdout }) : c.json({});
    } catch (err) {
      log.error('hooksRoutes: handler failed', { error: err instanceof Error ? err.message : String(err) });
      return c.json({});
    }
  });

  return app;
}
