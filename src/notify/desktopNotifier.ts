import { fileURLToPath } from 'node:url';
import notifier from 'node-notifier';
import type Database from 'better-sqlite3';
import type { HubConfig, HubEvent, Logger } from '../types.js';
import type { HubBus } from '../core/bus.js';
import * as sessionsRepo from '../db/repo/sessions.js';

export interface DesktopNotifierDeps {
  db: Database.Database;
  bus: HubBus;
  config: HubConfig;
  log: Logger;
}

export interface DesktopNotifier {
  stop(): void;
}

const TOOL_INPUT_PREVIEW_CHARS = 80;
const TOAST_MESSAGE_MAX_CHARS = 100;

// Field picked first wins — ordered by how often each carries the human-meaningful bit of the input.
const PREFERRED_INPUT_FIELDS = ['command', 'file_path', 'prompt', 'pattern', 'url', 'query', 'path'] as const;

const APP_ID = 'RightTech.CCHub';
const TOAST_ICON = fileURLToPath(new URL('../../assets/toast.png', import.meta.url));

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function truncateToast(s: string): string {
  return s.length > TOAST_MESSAGE_MAX_CHARS ? `${s.slice(0, TOAST_MESSAGE_MAX_CHARS - 1)}…` : s;
}

function pickHumanField(input: Record<string, unknown>): string {
  for (const key of PREFERRED_INPUT_FIELDS) {
    const v = input[key];
    if (v != null) return typeof v === 'string' ? v : JSON.stringify(v);
  }
  // AskUserQuestion shape: { questions: [{ question: "…" }, …] }.
  const questions = input.questions;
  if (Array.isArray(questions) && questions.length > 0) {
    const first: unknown = questions[0];
    if (isRecord(first) && typeof first.question === 'string') return first.question;
  }
  for (const v of Object.values(input)) {
    if (typeof v === 'string') return v;
  }
  return Object.keys(input).join(', ');
}

/** Human-readable toast body for a permission request: `Tool: <most meaningful input field>`. */
export function formatToolInput(toolName: string, toolInput: string | null): string {
  if (!toolInput) return toolName;
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolInput);
  } catch {
    return `${toolName}: ${toolInput.slice(0, TOOL_INPUT_PREVIEW_CHARS)}`;
  }
  const picked = isRecord(parsed) ? pickHumanField(parsed) : JSON.stringify(parsed);
  return truncateToast(`${toolName}: ${picked}`);
}

// Sessions are always known by the time a permission_request/session_event reaches the bus (the
// row/event is only ever emitted after the owning session has been upserted) — the short-id
// fallback only guards a race we don't expect to hit in practice.
function resolveInstanceName(db: Database.Database, sessionId: string): string {
  return sessionsRepo.getJoined(db, sessionId)?.instance_name ?? sessionId.slice(0, 8);
}

/** Notifications must never crash or block the hub — every call site goes through this. */
function toast(log: Logger, title: string, message?: string): void {
  try {
    // appID keys the Windows toast to the registered AppUserModelID (RightTech.CCHub shortcut);
    // node-notifier ignores unknown options on other platforms.
    notifier.notify({ title, message, appID: APP_ID, icon: TOAST_ICON });
  } catch (err) {
    log.debug('desktopNotifier: notify failed', { error: err instanceof Error ? err.message : String(err) });
  }
}

// Subscribes to HubBus and turns a subset of hub events into OS toast notifications (Windows via
// node-notifier/SnoreToast; macOS/Linux notifiers come along for free from the same package).
// Fire-and-forget, no click actions/callbacks in v1 — see toast() for the crash-proofing contract.
export function startDesktopNotifier(deps: DesktopNotifierDeps): DesktopNotifier {
  const { db, bus, config, log } = deps;

  // Tracks whether we're inside a "limited" episode that hasn't yet toasted its recovery. Using
  // an episode flag rather than literally comparing to the previous tick's state is deliberate:
  // the real watcher state machine goes limited -> waiting_reset -> continuing -> ok, so a strict
  // "previous state was exactly 'limited'" check would miss the recovery toast entirely. The flag
  // only flips on the two states we care about, so waiting_reset/continuing/unknown pass through
  // inert — no toast, no flapping, and the eventual 'ok' still closes out the episode correctly.
  let limitedEpisodeActive = false;

  function handle(e: HubEvent): void {
    switch (e.type) {
      case 'permission_request': {
        if (!config.notifications.permissionRequests) return;
        const name = resolveInstanceName(db, e.request.session_id);
        toast(log, `${name} — permission`, formatToolInput(e.request.tool_name, e.request.tool_input));
        return;
      }
      case 'session_event': {
        if (e.eventType === 'Notification') {
          if (!config.notifications.needsInput) return;
          const sess = sessionsRepo.getJoined(db, e.sessionId);
          const payload = isRecord(e.payload) ? e.payload : {};
          // CC fires idle_prompt ("Claude is waiting for your input") during long turns too. A
          // genuine idle wait always follows a Stop hook, which flips status to 'idle' long before
          // the 60s idle notification — so idle_prompt on a still-'active' session is a false
          // alarm. permission_prompt is left alone: mid-turn is exactly when it's real.
          if (payload.notification_type === 'idle_prompt' && sess?.status === 'active') {
            log.debug('desktopNotifier: suppressed idle_prompt toast, session mid-turn', { sessionId: e.sessionId });
            return;
          }
          const name = sess?.instance_name ?? e.sessionId.slice(0, 8);
          const message = typeof payload.message === 'string' ? payload.message : undefined;
          toast(log, `${name} needs input`, message);
          return;
        }
        if (e.eventType === 'Stop') {
          if (!config.notifications.turnEnd) return;
          const name = resolveInstanceName(db, e.sessionId);
          toast(log, `${name} finished a turn`);
          return;
        }
        return;
      }
      case 'limit_state': {
        if (!config.notifications.limit) return;
        const state = e.state.state;
        if (state === 'limited') {
          if (!limitedEpisodeActive) {
            limitedEpisodeActive = true;
            toast(log, 'cc_hub — usage limit', 'Usage limit reached');
          }
        } else if (state === 'ok') {
          if (limitedEpisodeActive) {
            limitedEpisodeActive = false;
            toast(log, 'cc_hub — usage limit', 'Usage limit reset — back to normal');
          }
        }
        // waiting_reset / continuing / unknown: no toast, and the episode flag is left untouched.
        return;
      }
      default:
        return;
    }
  }

  const unsubscribe = bus.on(handle);

  function stop(): void {
    unsubscribe();
  }

  return { stop };
}
