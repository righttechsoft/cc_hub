// Fan-out of bus events to connected mobile/WS clients. Self-subscribes to the bus at
// construction time so callers just need to register/unregister sockets as they connect.
import type { WSContext, WSMessageReceive } from 'hono/ws';
import type Database from 'better-sqlite3';
import type { HubEvent, IWsHub, Logger } from '../types.js';
import type { HubBus } from '../core/bus.js';
import * as sessions from '../db/repo/sessions.js';
import * as limitRepo from '../db/repo/limit.js';

interface WsFrame {
  type: string;
  data: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function toFrame(e: HubEvent): WsFrame {
  switch (e.type) {
    case 'session_event':
      return {
        type: 'session_event',
        data: { sessionId: e.sessionId, eventType: e.eventType, payload: e.payload, createdAt: e.createdAt },
      };
    case 'session_status':
      return { type: 'session_status', data: { sessionId: e.sessionId, status: e.status } };
    case 'message':
      return { type: 'message', data: e.message };
    case 'permission_request':
      return { type: 'permission_request', data: e.request };
    case 'permission_decided':
      return { type: 'permission_decided', data: e.request };
    case 'limit_state':
      return { type: 'limit_state', data: e.state };
    case 'chat_delivery':
      return { type: 'chat_delivery', data: { instance: e.instance, fromNames: e.fromNames, count: e.count, createdAt: e.createdAt } };
    default:
      return exhaustiveCheck(e);
  }
}

function exhaustiveCheck(v: never): never {
  throw new Error(`wsHub: unhandled HubEvent ${JSON.stringify(v)}`);
}

export class WsHub implements IWsHub {
  private readonly db: Database.Database;
  private readonly log: Logger;
  private readonly sockets = new Set<WSContext>();

  constructor(deps: { bus: HubBus; db: Database.Database; log: Logger }) {
    this.db = deps.db;
    this.log = deps.log;
    deps.bus.on((e) => this.broadcast(e));
  }

  register(ws: WSContext): void {
    this.sockets.add(ws);
    this.send(ws, {
      type: 'hello',
      data: {
        sessions: sessions.listJoined(this.db),
        limit: limitRepo.getState(this.db),
      },
    });
  }

  unregister(ws: WSContext): void {
    this.sockets.delete(ws);
  }

  handleMessage(ws: WSContext, raw: WSMessageReceive): void {
    if (typeof raw !== 'string') return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    if (isRecord(parsed) && parsed.type === 'ping') {
      this.send(ws, { type: 'pong', data: null });
    }
  }

  broadcast(e: HubEvent): void {
    const frame = toFrame(e);
    for (const ws of this.sockets) {
      this.send(ws, frame);
    }
  }

  private send(ws: WSContext, frame: WsFrame): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch (err) {
      this.log.warn('wsHub: send failed, dropping socket', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.sockets.delete(ws);
    }
  }
}
