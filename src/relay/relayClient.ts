// Hub-side tunnel client for the Cloudflare Worker relay. Holds one persistent control
// WebSocket to the worker's /connect endpoint, multiplexing relayed mobile HTTP requests
// (proxied to this hub's own HTTP server over loopback) and relayed WS channels (proxied to
// this hub's own /ws) over that single control connection. Reconnects with backoff on drop.
import WebSocket from 'ws'; // Node global WebSocket cannot set headers
import type { HubConfig, Logger } from '../types.js';

export interface RelayClient {
  stop(): void;
}

// SECURITY-CRITICAL: relayed fetches are dispatched to 127.0.0.1 and would otherwise pass the
// hub's localhostGate on /hooks and /mcp — this allowlist is the only thing keeping those
// unreachable from the public relay tunnel.
export function isAllowedApiPath(path: string): boolean {
  if (!path.startsWith('/api/v1/')) return false;
  // String-matching literal '..'/'%2e%2e' misses mixed encodings like '%2e.' / '.%2e', which the
  // WHATWG URL parser's dot-segment handling still collapses (e.g. '/api/v1/%2e./%2e./hooks'
  // normalizes to '/hooks'). Normalize first and re-check the prefix on the resolved pathname.
  let normalizedPath: string;
  try {
    normalizedPath = new URL('http://x' + path).pathname;
  } catch {
    return false;
  }
  return normalizedPath.startsWith('/api/v1/');
}

interface ReqFrame {
  t: 'req';
  id: string;
  method: string;
  path: string;
  headers?: Record<string, string> | null;
  body?: string | null;
}

interface WsOpenFrame {
  t: 'ws_open';
  ch: string;
}

interface WsMsgFrame {
  t: 'ws_msg';
  ch: string;
  data: string;
}

interface WsCloseFrame {
  t: 'ws_close';
  ch: string;
  code?: number;
  reason?: string;
}

const KEEPALIVE_MS = 30_000;
const REQ_TIMEOUT_MS = 25_000; // < worker's 30s so mobile sees this specific error, not a generic timeout
const MAX_BODY_LEN = 950_000;
const MIN_OPEN_MS_FOR_RESET = 30_000;
const MAX_BACKOFF_MS = 60_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export function startRelayClient(deps: { config: HubConfig; log: Logger }): RelayClient {
  const { config, log } = deps;

  let ws: WebSocket | null = null;
  const channels = new Map<string, WebSocket>();
  // The worker starts relaying ws_msg immediately after ws_open, but the local ws://127.0.0.1/ws
  // handshake takes a few ms — buffer frames that arrive while still CONNECTING and flush them
  // once the local socket opens, instead of silently dropping them.
  const pendingChannelMsgs = new Map<string, string[]>();
  let attempt = 0;
  let openedAt = 0;
  let awaitingPong = false;
  let stopped = false;
  let closedHandled = false;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function sendControl(frame: unknown): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch (err) {
      log.warn('relay: sendControl failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  function clearKeepalive(): void {
    if (keepaliveTimer) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = null;
    }
  }

  function startKeepalive(): void {
    clearKeepalive();
    awaitingPong = false;
    keepaliveTimer = setInterval(() => {
      if (stopped) return;
      if (awaitingPong) {
        ws?.terminate(); // dead link — 'close' fires next, triggering reconnect
        return;
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        awaitingPong = true;
        ws.send('{"type":"ping"}');
      }
    }, KEEPALIVE_MS);
  }

  function closeAllChannels(): void {
    for (const ch of channels.values()) {
      try {
        ch.close();
      } catch {
        // ignore — socket may already be closing
      }
    }
    channels.clear();
    pendingChannelMsgs.clear();
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    const delay = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
    attempt++;
    reconnectTimer = setTimeout(() => {
      if (stopped) return;
      connect();
    }, delay);
  }

  async function handleReq(frame: ReqFrame): Promise<void> {
    if (!isAllowedApiPath(frame.path)) {
      sendControl({
        t: 'res',
        id: frame.id,
        status: 403,
        contentType: 'application/json',
        body: '{"error":{"code":"forbidden","message":"path not allowed"}}',
      });
      return;
    }
    try {
      const r = await fetch('http://127.0.0.1:' + config.port + frame.path, {
        method: frame.method,
        headers: frame.headers ?? {},
        body: frame.body ?? undefined,
        signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
      });
      const text = await r.text();
      const resFrame = {
        t: 'res',
        id: frame.id,
        status: r.status,
        contentType: r.headers.get('content-type') ?? 'application/json',
        body: text,
      };
      // Measure the actual serialized control frame in bytes, not text.length (UTF-16 code
      // units) — UTF-8 multi-byte inflation and JSON.stringify escaping can push a response that
      // "looks" under the limit over the Durable Object's 1 MiB inbound WebSocket message cap.
      if (Buffer.byteLength(JSON.stringify(resFrame), 'utf8') > MAX_BODY_LEN) {
        sendControl({
          t: 'res',
          id: frame.id,
          status: 502,
          contentType: 'application/json',
          body: '{"error":{"code":"relay_body_too_large","message":"response body too large"}}',
        });
        return;
      }
      sendControl(resFrame);
    } catch (err) {
      sendControl({
        t: 'res',
        id: frame.id,
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'hub_fetch_failed', message: err instanceof Error ? err.message : String(err) },
        }),
      });
    }
  }

  function handleWsOpen(frame: WsOpenFrame): void {
    const local = new WebSocket('ws://127.0.0.1:' + config.port + '/ws?token=' + encodeURIComponent(config.authToken));
    channels.set(frame.ch, local);
    local.on('open', () => {
      const queued = pendingChannelMsgs.get(frame.ch);
      if (queued) {
        pendingChannelMsgs.delete(frame.ch);
        for (const data of queued) local.send(data);
      }
    });
    local.on('message', (d) => {
      sendControl({ t: 'ws_msg', ch: frame.ch, data: d.toString() });
    });
    const onDone = (): void => {
      channels.delete(frame.ch);
      pendingChannelMsgs.delete(frame.ch);
      sendControl({ t: 'ws_close', ch: frame.ch, code: 1000, reason: '' });
    };
    local.on('close', onDone);
    local.on('error', onDone);
  }

  function handleWsMsg(frame: WsMsgFrame): void {
    const local = channels.get(frame.ch);
    if (!local) return;
    if (local.readyState === WebSocket.OPEN) {
      local.send(frame.data);
    } else if (local.readyState === WebSocket.CONNECTING) {
      let queued = pendingChannelMsgs.get(frame.ch);
      if (!queued) {
        queued = [];
        pendingChannelMsgs.set(frame.ch, queued);
      }
      queued.push(frame.data);
    }
  }

  function handleWsClose(frame: WsCloseFrame): void {
    channels.get(frame.ch)?.close();
    channels.delete(frame.ch);
    pendingChannelMsgs.delete(frame.ch);
  }

  function handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    if (parsed.type === 'pong') {
      awaitingPong = false;
      return;
    }
    try {
      switch (parsed.t) {
        case 'req':
          void handleReq(parsed as unknown as ReqFrame);
          break;
        case 'ws_open':
          handleWsOpen(parsed as unknown as WsOpenFrame);
          break;
        case 'ws_msg':
          handleWsMsg(parsed as unknown as WsMsgFrame);
          break;
        case 'ws_close':
          handleWsClose(parsed as unknown as WsCloseFrame);
          break;
        default:
          // frames with `type` instead of `t` are keepalive/noise — ignore
          break;
      }
    } catch (err) {
      log.warn('relay: failed to handle control frame', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  function connect(): void {
    if (stopped) return;
    closedHandled = false;
    const url = config.relay.url.replace(/^http/, 'ws') + '/connect';
    const socket = new WebSocket(url, { headers: { 'x-hub-secret': config.relay.secret } });
    ws = socket;

    socket.on('open', () => {
      log.info('relay: connected', { url });
      openedAt = Date.now();
      startKeepalive();
    });

    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      handleMessage(data.toString());
    });

    const onDown = (reason: string, extra?: unknown): void => {
      if (closedHandled) return;
      closedHandled = true;
      log.warn(`relay: ${reason}`, extra);
      clearKeepalive();
      closeAllChannels();
      if (openedAt !== 0 && Date.now() - openedAt >= MIN_OPEN_MS_FOR_RESET) {
        attempt = 0;
      }
      openedAt = 0;
      if (!stopped) scheduleReconnect();
    };

    socket.on('close', (code, reasonBuf) => {
      onDown('disconnected', { code, reason: reasonBuf.toString() });
    });
    socket.on('error', (err) => {
      onDown('connection error', { error: err instanceof Error ? err.message : String(err) });
    });
  }

  function stop(): void {
    stopped = true;
    clearKeepalive();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    closeAllChannels();
    ws?.close();
  }

  connect();

  return { stop };
}
