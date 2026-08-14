// Top-level Hono assembly: localhost gate for hooks/mcp, bearer auth for the mobile API/WS,
// route mounting, and the /ws upgrade endpoint. All DB/bus/service wiring is done by the
// composition root (src/index.ts) and handed in as `deps`.
import { Hono, type MiddlewareHandler } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { HubConfig, IAttachRegistry, IPromptDelivery, ILimitWatcher, Logger } from '../types.js';
import type { HubBus } from '../core/bus.js';
import * as instancesRepo from '../db/repo/instances.js';
import * as instanceAppsRepo from '../db/repo/instanceApps.js';
import { WsHub } from './wsHub.js';
import { ADMIN_HTML } from './adminUi.js';

type Bindings = { Bindings: HttpBindings };

const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch; tokens here are fixed-format ("Bearer <token>"
  // or the raw token), so a length check first is the conventional guard.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function localhostGate(): MiddlewareHandler<Bindings> {
  return async (c, next) => {
    const remoteAddress = c.env.incoming.socket.remoteAddress;
    if (!remoteAddress || !LOCAL_ADDRESSES.has(remoteAddress)) {
      return c.json({ error: { code: 'forbidden', message: 'localhost only' } }, 403);
    }
    await next();
  };
}

function bearerAuth(authToken: string): MiddlewareHandler<Bindings> {
  const expected = `Bearer ${authToken}`;
  return async (c, next) => {
    const header = c.req.header('Authorization');
    if (!header || !constantTimeEquals(header, expected)) {
      return c.json({ error: { code: 'unauthorized', message: 'missing or invalid bearer token' } }, 401);
    }
    await next();
  };
}

function wsAuth(authToken: string): MiddlewareHandler<Bindings> {
  const expectedHeader = `Bearer ${authToken}`;
  return async (c, next) => {
    const header = c.req.header('Authorization');
    const token = c.req.query('token');
    const headerOk = header !== undefined && constantTimeEquals(header, expectedHeader);
    const tokenOk = token !== undefined && constantTimeEquals(token, authToken);
    if (!headerOk && !tokenOk) {
      return c.json({ error: { code: 'unauthorized', message: 'missing or invalid token' } }, 401);
    }
    await next();
  };
}

export interface BuildAppDeps {
  config: HubConfig;
  db: Database.Database;
  bus: HubBus;
  log: Logger;
  gateway: { handle(c: any): Promise<Response> };
  delivery: IPromptDelivery;
  watcher: ILimitWatcher | undefined;
  attach: IAttachRegistry;
  hooksRoutes: Hono;
  apiRoutes: Hono;
}

const NOTICE_KINDS = new Set(['build_failed', 'url']);
const NOTICE_TEXT_MAX_CHARS = 300;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export interface BuiltApp {
  app: Hono<Bindings>;
  injectWebSocket: (server: any) => void;
  wsHub: WsHub;
}

export function buildApp(deps: BuildAppDeps): BuiltApp {
  const { config, db, bus, log, gateway, attach, hooksRoutes, apiRoutes } = deps;

  const app = new Hono<Bindings>();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  const wsHub = new WsHub({ bus, db, log, attach });

  app.use('/hooks/*', localhostGate());
  app.use('/mcp', localhostGate());
  // Same posture as /hooks and /mcp: a wrapper terminal injects keystrokes into a real `claude`
  // process, so this must never be reachable via LAN or the relay tunnel (see
  // src/relay/relayClient.ts's isAllowedApiPath, deliberately left untouched by this feature).
  if (config.attach.enabled) app.use('/attach', localhostGate());

  app.use('/api/*', bearerAuth(config.authToken));
  app.use('/ws', wsAuth(config.authToken));

  app.route('/hooks', hooksRoutes);
  app.route('/api/v1', apiRoutes);
  app.all('/mcp', (c) => gateway.handle(c));

  // Static admin page (view/edit/delete Athen notes + chat messages). Intentionally NOT gated by
  // localhostGate or bearerAuth: the page itself is static and holds no data — every data call it
  // makes goes through the bearer-authed /api/v1 routes above, same trust level as the mobile app.
  // It's also inherently unreachable via the relay: relayClient.ts's isAllowedApiPath only
  // forwards /api/v1/*, so /admin only ever works on the LAN.
  app.get('/admin', (c) => c.html(ADMIN_HTML));

  app.get(
    '/ws',
    upgradeWebSocket(() => ({
      onOpen: (_evt, ws) => wsHub.register(ws),
      onMessage: (evt, ws) => wsHub.handleMessage(ws, evt.data),
      onClose: (_evt, ws) => wsHub.unregister(ws),
    }))
  );

  // Kill switch (config.attach.enabled=false) — don't mount the endpoint at all; the wrapper's
  // WS just fails to connect and retries harmlessly, and the (empty) registry makes every
  // inject() return false, so delivery is pure headless fallback, identical to pre-attach.
  if (config.attach.enabled) {
    app.get(
    '/attach',
    upgradeWebSocket(() => {
      // Registered cwd for this connection — closed over so onClose/onError can unregister the
      // right slot without the registry needing to reverse-lookup a ws.
      let registeredCwd: string | undefined;

      return {
        onMessage: (evt, ws) => {
          if (typeof evt.data !== 'string') return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(evt.data);
          } catch {
            return;
          }
          if (!isRecord(parsed)) return;

          if (parsed.t === 'register' && typeof parsed.cwd === 'string') {
            registeredCwd = parsed.cwd;
            attach.register(parsed.cwd, {
              ws,
              pid: typeof parsed.pid === 'number' ? parsed.pid : 0,
              lastSeen: Date.now(),
            });
            log.info('attach: register', { cwd: parsed.cwd });
            return;
          }

          if (parsed.type === 'ping') {
            if (registeredCwd) attach.touch(registeredCwd, ws);
            ws.send(JSON.stringify({ type: 'pong', data: null }));
            return;
          }

          if (parsed.t === 'output' && typeof parsed.b64 === 'string') {
            if (registeredCwd) attach.ingestOutput(registeredCwd, parsed.b64);
            return;
          }

          if (parsed.t === 'working' && typeof parsed.on === 'boolean') {
            if (registeredCwd) attach.setWorking(registeredCwd, parsed.on);
            return;
          }

          if (parsed.t === 'notice' && typeof parsed.kind === 'string' && typeof parsed.text === 'string') {
            if (registeredCwd && NOTICE_KINDS.has(parsed.kind)) {
              const text = parsed.text.slice(0, NOTICE_TEXT_MAX_CHARS);
              bus.emit({ type: 'attach_notice', cwd: registeredCwd, kind: parsed.kind, text });

              // Automatic capture: a 'url' notice IS the dev-server URL (see outputScanner.ts) —
              // persist it onto the instance for the admin footer. Best-effort: a persistence
              // failure must not break the /attach WS handler.
              if (parsed.kind === 'url') {
                try {
                  const instance = instancesRepo.byCwd(db, registeredCwd);
                  if (instance) {
                    const now = Date.now();
                    instancesRepo.setAppUrl(db, instance.id, text, now);
                    instanceAppsRepo.upsert(db, instance.id, instanceAppsRepo.labelFromUrl(text), text, now);
                  }
                } catch (err) {
                  log.warn('attach: failed to persist app url', {
                    cwd: registeredCwd,
                    error: err instanceof Error ? err.message : String(err),
                  });
                }
              }
            }
          }
        },
        onClose: (_evt, ws) => {
          if (registeredCwd) attach.unregister(registeredCwd, ws);
        },
        onError: (_evt, ws) => {
          if (registeredCwd) attach.unregister(registeredCwd, ws);
        },
      };
    })
    );
  }

  return { app, injectWebSocket, wsHub };
}
