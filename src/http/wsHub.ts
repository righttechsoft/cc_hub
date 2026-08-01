// Fan-out of bus events to connected mobile/WS clients. Self-subscribes to the bus at
// construction time so callers just need to register/unregister sockets as they connect.
import type { WSContext, WSMessageReceive } from 'hono/ws';
import type Database from 'better-sqlite3';
import type { HubEvent, IAttachRegistry, IWsHub, Logger } from '../types.js';
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
    case 'attach_output':
      return { type: 'attach_output', data: { cwd: e.cwd, b64: e.b64 } };
    case 'attach_status':
      return { type: 'attach_status', data: { cwd: e.cwd, attached: e.attached } };
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
  private readonly attach: IAttachRegistry;
  private readonly sockets = new Set<WSContext>();
  // One attach subscription per socket — a new attach_subscribe replaces the prior, matching the
  // pinned protocol's "one cwd per socket" rule.
  private readonly subs = new Map<WSContext, string>();

  constructor(deps: { bus: HubBus; db: Database.Database; log: Logger; attach: IAttachRegistry }) {
    this.db = deps.db;
    this.log = deps.log;
    this.attach = deps.attach;
    deps.bus.on((e) => this.broadcast(e));
  }

  register(ws: WSContext): void {
    this.sockets.add(ws);
    this.send(ws, {
      type: 'hello',
      data: {
        sessions: sessions.listJoined(this.db),
        limit: limitRepo.getState(this.db),
        attached: this.attach.listAttached(),
      },
    });
  }

  unregister(ws: WSContext): void {
    this.sockets.delete(ws);
    this.subs.delete(ws);
  }

  handleMessage(ws: WSContext, raw: WSMessageReceive): void {
    if (typeof raw !== 'string') return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;

    if (parsed.type === 'ping') {
      this.send(ws, { type: 'pong', data: null });
      return;
    }

    if (parsed.type === 'attach_subscribe' && isRecord(parsed.data) && typeof parsed.data.cwd === 'string') {
      const cwd = parsed.data.cwd;
      this.subs.set(ws, cwd);
      const ring = this.attach.getRingB64(cwd);
      if (ring) this.send(ws, { type: 'attach_output', data: { cwd, b64: ring } });
      return;
    }

    if (parsed.type === 'attach_unsubscribe') {
      this.subs.delete(ws);
    }
  }

  broadcast(e: HubEvent): void {
    if (e.type === 'attach_output') {
      const frame = toFrame(e);
      for (const ws of this.sockets) {
        if (this.subs.get(ws) === e.cwd) this.send(ws, frame);
      }
      return;
    }
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
