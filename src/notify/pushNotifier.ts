import type Database from 'better-sqlite3';
import type { HubConfig, HubEvent, Logger } from '../types.js';
import type { HubBus } from '../core/bus.js';
import * as sessionsRepo from '../db/repo/sessions.js';
import * as pushTokensRepo from '../db/repo/pushTokens.js';
import { formatToolInput, truncateToast } from './desktopNotifier.js';
import type { AwayDetector } from './awayDetector.js';
import type { ApnsSender } from './apns.js';

export interface PushNotifierDeps {
  db: Database.Database;
  bus: HubBus;
  config: HubConfig;
  log: Logger;
  away: Pick<AwayDetector, 'isAway'>;
  sender: Pick<ApnsSender, 'send'>;
}

export interface PushNotifier {
  stop(): void;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Sessions are always known by the time a permission_request/session_event reaches the bus — see
// the identical comment in desktopNotifier.ts.
function resolveInstanceName(db: Database.Database, sessionId: string): string {
  return sessionsRepo.getJoined(db, sessionId)?.instance_name ?? sessionId.slice(0, 8);
}

// Subscribes to HubBus and mirrors desktopNotifier's event selection, but sends APNs pushes
// instead of toasts, and only while the desktop user is away — see awayDetector.
export function startPushNotifier(deps: PushNotifierDeps): PushNotifier {
  const { db, bus, config, log, away, sender } = deps;

  let limitedEpisodeActive = false;

  async function pushAll(title: string, message?: string): Promise<void> {
    try {
      const tokens = pushTokensRepo.list(db);
      if (tokens.length === 0) return;

      const results = await Promise.allSettled(
        tokens.map(async (row) => {
          const result = await sender.send(row.token, title, message);
          if (result === 'unregistered') {
            pushTokensRepo.remove(db, row.token);
            log.info('pushNotifier: removed dead token');
          }
        })
      );
      for (const r of results) {
        if (r.status === 'rejected') {
          log.warn('pushNotifier: send failed', { error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
        }
      }
    } catch (err) {
      log.warn('pushNotifier: pushAll failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  function handle(e: HubEvent): void {
    if (!away.isAway()) return;

    switch (e.type) {
      case 'permission_request': {
        if (!config.notifications.permissionRequests) return;
        const name = resolveInstanceName(db, e.request.session_id);
        void pushAll(`${name} — permission`, formatToolInput(e.request.tool_name, e.request.tool_input));
        return;
      }
      case 'session_event': {
        if (e.eventType === 'Notification') {
          if (!config.notifications.needsInput) return;
          const sess = sessionsRepo.getJoined(db, e.sessionId);
          const payload = isRecord(e.payload) ? e.payload : {};
          if (payload.notification_type === 'idle_prompt' && sess?.status === 'active') {
            log.debug('pushNotifier: suppressed idle_prompt push, session mid-turn', { sessionId: e.sessionId });
            return;
          }
          const name = sess?.instance_name ?? e.sessionId.slice(0, 8);
          const message = typeof payload.message === 'string' ? payload.message : undefined;
          void pushAll(`${name} needs input`, message);
          return;
        }
        if (e.eventType === 'Stop') {
          if (!config.notifications.turnEnd) return;
          const name = resolveInstanceName(db, e.sessionId);
          void pushAll(`${name} finished a turn`);
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
            void pushAll('cc_hub — usage limit', 'Usage limit reached');
          }
        } else if (state === 'ok') {
          if (limitedEpisodeActive) {
            limitedEpisodeActive = false;
            void pushAll('cc_hub — usage limit', 'Usage limit reset — back to normal');
          }
        }
        return;
      }
      case 'chat_delivery': {
        if (!config.notifications.chatDelivery) return;
        void pushAll(
          `${e.instance} — incoming chat`,
          truncateToast(`processing ${e.count} message${e.count === 1 ? '' : 's'} from ${e.fromNames.join(', ')}`)
        );
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
