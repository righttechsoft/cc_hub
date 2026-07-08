// Top-level Hono assembly: localhost gate for hooks/mcp, bearer auth for the mobile API/WS,
// route mounting, and the /ws upgrade endpoint. All DB/bus/service wiring is done by the
// composition root (src/index.ts) and handed in as `deps`.
import { Hono, type MiddlewareHandler } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { HubConfig, IPromptDelivery, ILimitWatcher, Logger } from '../types.js';
import type { HubBus } from '../core/bus.js';
import { WsHub } from './wsHub.js';

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
  hooksRoutes: Hono;
  apiRoutes: Hono;
}

export interface BuiltApp {
  app: Hono<Bindings>;
  injectWebSocket: (server: any) => void;
  wsHub: WsHub;
}

export function buildApp(deps: BuildAppDeps): BuiltApp {
  const { config, db, bus, log, gateway, hooksRoutes, apiRoutes } = deps;

  const app = new Hono<Bindings>();
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

  const wsHub = new WsHub({ bus, db, log });

  app.use('/hooks/*', localhostGate());
  app.use('/mcp', localhostGate());

  app.use('/api/*', bearerAuth(config.authToken));
  app.use('/ws', wsAuth(config.authToken));

  app.route('/hooks', hooksRoutes);
  app.route('/api/v1', apiRoutes);
  app.all('/mcp', (c) => gateway.handle(c));

  app.get(
    '/ws',
    upgradeWebSocket(() => ({
      onOpen: (_evt, ws) => wsHub.register(ws),
      onMessage: (evt, ws) => wsHub.handleMessage(ws, evt.data),
      onClose: (_evt, ws) => wsHub.unregister(ws),
    }))
  );

  return { app, injectWebSocket, wsHub };
}
