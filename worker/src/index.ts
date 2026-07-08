import { DurableObject } from 'cloudflare:workers';

export interface Env {
  HUB_RELAY: DurableObjectNamespace;
  AUTH_TOKEN: string;
  HUB_SECRET: string;
}

const KEEPALIVE_REQUEST = '{"type":"ping"}';
const KEEPALIVE_RESPONSE = '{"type":"pong","data":null}';
const MAX_BODY_BYTES = 950000;
const REQUEST_TIMEOUT_MS = 30000;

async function timingSafeEqualStr(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (a: BufferSource, b: BufferSource) => boolean;
  };
  if (typeof subtle.timingSafeEqual === 'function') {
    return subtle.timingSafeEqual(aBytes, bBytes);
  }
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : null;
}

function forwardToDO(request: Request, env: Env): Promise<Response> {
  const id = env.HUB_RELAY.idFromName('hub');
  const stub = env.HUB_RELAY.get(id);
  return stub.fetch(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const isUpgrade = (request.headers.get('Upgrade') ?? '').toLowerCase() === 'websocket';

    if (url.pathname === '/connect') {
      if (!isUpgrade) return new Response('expected websocket', { status: 426 });
      const secret = request.headers.get('x-hub-secret') ?? '';
      const ok = await timingSafeEqualStr(secret, env.HUB_SECRET);
      if (!ok) return new Response('unauthorized', { status: 401 });
      return forwardToDO(request, env);
    }

    if (url.pathname === '/ws') {
      if (!isUpgrade) return new Response('expected websocket', { status: 426 });
      const token = url.searchParams.get('token') ?? bearerToken(request) ?? '';
      const ok = await timingSafeEqualStr(token, env.AUTH_TOKEN);
      if (!ok) return new Response('unauthorized', { status: 401 });
      return forwardToDO(request, env);
    }

    if (url.pathname.startsWith('/api/v1/')) {
      const authHeader = request.headers.get('authorization') ?? '';
      const expected = 'Bearer ' + env.AUTH_TOKEN;
      const ok = await timingSafeEqualStr(authHeader, expected);
      if (!ok) return new Response('unauthorized', { status: 401 });
      const contentLength = Number(request.headers.get('content-length') ?? '0');
      if (contentLength > MAX_BODY_BYTES) return new Response('payload too large', { status: 413 });
      return forwardToDO(request, env);
    }

    return new Response('not found', { status: 404 });
  },
};

type HubAttachment = { role: 'hub' };
type MobileAttachment = { role: 'mobile'; ch: string };
type Attachment = HubAttachment | MobileAttachment;

interface PendingResult {
  status: number;
  contentType: string;
  body: string;
}

interface PendingEntry {
  resolve: (result: PendingResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class HubRelay extends DurableObject<Env> {
  pending: Map<string, PendingEntry>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.pending = new Map();
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(KEEPALIVE_REQUEST, KEEPALIVE_RESPONSE));
  }

  private hubSocket(): WebSocket | undefined {
    // A hub reconnect (/connect) closes the old socket with 1012 'replaced', but that socket
    // stays in getWebSockets('hub') in CLOSING state until its close handshake completes — which
    // can take a while if the old peer is dead. Scan for an OPEN socket rather than trusting
    // index 0, or a still-closing old socket can shadow the freshly connected hub.
    return this.ctx.getWebSockets('hub').find((ws) => ws.readyState === WebSocket.READY_STATE_OPEN);
  }

  private safeSend(ws: WebSocket, data: string): void {
    try {
      ws.send(data);
    } catch {
      // drop silently
    }
  }

  private hubOfflineResponse(): PendingResult {
    return {
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'hub_offline', message: 'hub not connected' } }),
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/connect') {
      for (const ws of this.ctx.getWebSockets('hub')) {
        try {
          ws.close(1012, 'replaced');
        } catch {
          // ignore
        }
      }
      for (const ws of this.ctx.getWebSockets('mobile')) {
        try {
          ws.close(1012, 'replaced');
        } catch {
          // ignore
        }
      }
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server, ['hub']);
      server.serializeAttachment({ role: 'hub' } satisfies Attachment);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/ws') {
      const hub = this.hubSocket();
      if (!hub) {
        const offline = this.hubOfflineResponse();
        return new Response(offline.body, { status: offline.status, headers: { 'content-type': offline.contentType } });
      }
      const ch = crypto.randomUUID();
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server, ['mobile', ch]);
      server.serializeAttachment({ role: 'mobile', ch } satisfies Attachment);
      this.safeSend(hub, JSON.stringify({ t: 'ws_open', ch }));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname.startsWith('/api/v1/')) {
      const hub = this.hubSocket();
      if (!hub) {
        const offline = this.hubOfflineResponse();
        return new Response(offline.body, { status: offline.status, headers: { 'content-type': offline.contentType } });
      }

      const id = crypto.randomUUID();
      const body = request.method === 'GET' || request.method === 'HEAD' ? null : await request.text();
      // The outer fetch handler's cap only trusts content-length, which is absent/unreliable for
      // chunked requests — enforce the cap again here on the actual body now that it's read.
      if (body && body.length > MAX_BODY_BYTES) return new Response('payload too large', { status: 413 });
      const headers: Record<string, string> = {};
      const authorization = request.headers.get('authorization');
      if (authorization) headers.authorization = authorization;
      const contentType = request.headers.get('content-type');
      if (contentType) headers['content-type'] = contentType;

      const frame = {
        t: 'req',
        id,
        method: request.method,
        path: url.pathname + url.search,
        headers,
        body,
      };

      const result = await new Promise<PendingResult>((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          resolve({
            status: 504,
            contentType: 'application/json',
            body: JSON.stringify({ error: { code: 'hub_timeout', message: 'hub did not respond in time' } }),
          });
        }, REQUEST_TIMEOUT_MS);
        this.pending.set(id, { resolve, timer });
        this.safeSend(hub, JSON.stringify(frame));
      });

      return new Response(result.body, {
        status: result.status,
        headers: { 'content-type': result.contentType },
      });
    }

    return new Response('not found', { status: 404 });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== 'string') return;
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment) return;

    if (attachment.role === 'hub') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let frame: any;
      try {
        frame = JSON.parse(message);
      } catch {
        return;
      }

      if (frame.t === 'res') {
        const entry = this.pending.get(frame.id);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(frame.id);
          entry.resolve({
            status: frame.status,
            contentType: frame.contentType,
            body: frame.body,
          });
        }
      } else if (frame.t === 'ws_msg') {
        const target = this.ctx.getWebSockets(frame.ch)[0];
        if (target) {
          try {
            target.send(frame.data);
          } catch {
            // drop silently
          }
        }
      } else if (frame.t === 'ws_close') {
        const target = this.ctx.getWebSockets(frame.ch)[0];
        if (target) {
          try {
            target.close(frame.code ?? 1000, frame.reason ?? '');
          } catch {
            // drop silently
          }
        }
      }
      return;
    }

    // role === 'mobile'
    const hub = this.hubSocket();
    if (hub) {
      this.safeSend(hub, JSON.stringify({ t: 'ws_msg', ch: attachment.ch, data: message }));
    } else {
      try {
        ws.close(1013, 'hub offline');
      } catch {
        // ignore
      }
    }
  }

  webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment) return;
    this.handleSocketGone(attachment);
  }

  webSocketError(ws: WebSocket, _error: unknown): void {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment) return;
    this.handleSocketGone(attachment);
  }

  private handleSocketGone(attachment: Attachment): void {
    if (attachment.role === 'hub') {
      // The deferred webSocketClose/webSocketError of an OLD hub socket (closed with 1012
      // 'replaced' during /connect) can fire after a NEW hub socket is already connected. If a
      // live hub socket exists, this event is stale — bail out instead of nuking in-flight
      // requests and reconnected mobile clients that belong to the new connection.
      if (this.hubSocket()) return;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.resolve(this.hubOfflineResponse());
      }
      this.pending.clear();
      for (const mobile of this.ctx.getWebSockets('mobile')) {
        try {
          mobile.close(1013, 'hub offline');
        } catch {
          // ignore
        }
      }
    } else {
      const hub = this.hubSocket();
      if (hub) {
        this.safeSend(hub, JSON.stringify({ t: 'ws_close', ch: attachment.ch, code: 1000, reason: '' }));
      }
    }
  }
}
