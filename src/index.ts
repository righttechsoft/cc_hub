// Composition root: wires config -> db -> bus -> runner/delivery/continuation -> (optional)
// limit watcher -> hooks/mcp/api routes -> Hono app -> HTTP+WS server, plus the daily retention
// job and graceful shutdown. No business logic lives here — only construction and wiring.
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { openDb } from './db/db.js';
import { HubBus } from './core/bus.js';
import * as eventsRepo from './db/repo/events.js';
import * as messagesRepo from './db/repo/messages.js';
import { ClaudeRunner } from './runner/claudeRunner.js';
import { PromptDelivery } from './runner/promptDelivery.js';
import { ContinuationRunner } from './limit/continuation.js';
import { startLimitWatcher } from './limit/watcher.js';
import { buildHooksRoutes } from './http/hooksRoutes.js';
import { McpGateway } from './mcp/server.js';
import { buildApiRoutes } from './http/apiRoutes.js';
import { buildApp } from './http/app.js';
import { startRelayClient } from './relay/relayClient.js';
import { startChatDelivery } from './chat/chatDelivery.js';
import { createEmbedder } from './kb/embedder.js';
import { createAthen } from './kb/athen.js';
import type { ILimitWatcher } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CLAUDE_RUNNER_MAX_CONCURRENT = 4;

// Resolve paths against the project root (this file's directory / ..), never process.cwd(),
// so `data/` and `logs/` land next to package.json regardless of where cc_hub was launched from.
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const config = loadConfig();
const log = createLogger(config.logLevel, join(projectRoot, 'logs', 'cc_hub.log'));
const db = openDb(join(projectRoot, 'data', 'cc_hub.db'));
const bus = new HubBus();

const runner = new ClaudeRunner(config.claudePath, CLAUDE_RUNNER_MAX_CONCURRENT, log);
const delivery = new PromptDelivery({ db, bus, log, runner, config });
const continuation = new ContinuationRunner({ db, bus, log, delivery, config });

const watcher: ILimitWatcher | undefined = config.limitWatcher.enabled
  ? startLimitWatcher({ db, config, bus, log, continuation })
  : undefined;

const chatDelivery = config.chatDelivery.enabled ? startChatDelivery({ db, log, config, delivery }) : undefined;

const hooksRoutes = buildHooksRoutes({
  config,
  db,
  bus,
  log,
  delivery,
  getWatcher: () => watcher,
  runner,
});

const pokeChatDelivery = chatDelivery ? () => chatDelivery.pokeNow() : undefined;

const embedder = config.athen.embeddings
  ? createEmbedder({ config, log, modelCacheDir: join(projectRoot, 'data', 'models') })
  : undefined;
const athen = createAthen({ db, log, embedder });

const gateway = new McpGateway({ db, bus, log, athen, pokeChatDelivery });

const startedAt = Date.now();
const apiRoutes = buildApiRoutes({
  config,
  db,
  bus,
  log,
  delivery,
  watcher,
  runner,
  athen,
  startedAt,
  pokeChatDelivery,
});

const { app, injectWebSocket } = buildApp({
  config,
  db,
  bus,
  log,
  gateway,
  delivery,
  watcher,
  hooksRoutes,
  apiRoutes,
});

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.bindAddress });
injectWebSocket(server);

const relay = config.relay.enabled ? startRelayClient({ config, log }) : undefined;

function runRetention(): void {
  const now = Date.now();
  const purgedEvents = eventsRepo.purgeOlderThan(db, now - config.retention.sessionEventsDays * DAY_MS);
  const purgedMessages = messagesRepo.purgeReadOlderThan(db, now - config.retention.messagesDays * DAY_MS);
  if (purgedEvents > 0 || purgedMessages > 0) {
    log.info(`retention: purged ${purgedEvents} session_events, ${purgedMessages} read messages`);
  }
}

runRetention();
const retentionTimer = setInterval(runRetention, DAY_MS);

function lanIPv4Addresses(): string[] {
  const addresses: string[] = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) addresses.push(iface.address);
    }
  }
  return addresses;
}

log.info(`cc_hub listening on ${config.bindAddress}:${config.port}`);
const lan = lanIPv4Addresses();
log.info(lan.length > 0 ? `LAN IPv4: ${lan.join(', ')}` : 'LAN IPv4: (none detected)');
log.info(`claude mcp add --scope user --transport http cc-hub http://127.0.0.1:${config.port}/mcp`);

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`received ${signal}, shutting down`);
  clearInterval(retentionTimer);
  watcher?.stop();
  relay?.stop();
  chatDelivery?.stop();
  athen.stop();
  db.close();
  server.close();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Defense in depth: no floating promise anywhere in the app (background timers, fire-and-forget
// spawns, etc.) should be able to take down chat/KB/hooks/MCP/mobile API by rejecting unobserved.
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', { error: reason instanceof Error ? reason.message : String(reason) });
});
