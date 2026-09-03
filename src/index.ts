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
import * as instancesRepo from './db/repo/instances.js';
import * as sessionsRepo from './db/repo/sessions.js';
import { ClaudeRunner } from './runner/claudeRunner.js';
import { PromptDelivery } from './runner/promptDelivery.js';
import { AttachRegistry } from './attach/attachRegistry.js';
import { ContinuationRunner } from './limit/continuation.js';
import { startLimitWatcher } from './limit/watcher.js';
import { buildHooksRoutes } from './http/hooksRoutes.js';
import { McpGateway } from './mcp/server.js';
import { buildApiRoutes } from './http/apiRoutes.js';
import { buildApp } from './http/app.js';
import { startRelayClient } from './relay/relayClient.js';
import { startChatDelivery } from './chat/chatDelivery.js';
import { startSessionReaper } from './sessions/reaper.js';
import { startMessageSummarizer } from './chat/messageSummarizer.js';
import { createEmbedder } from './kb/embedder.js';
import { createAthen } from './kb/athen.js';
import { createOverlord } from './overlord/overlord.js';
import { createTerminalSpawner } from './spawn/terminalSpawner.js';
import { createDispatcher } from './spawn/dispatcher.js';
import { startDesktopNotifier } from './notify/desktopNotifier.js';
import { startAwayDetector } from './notify/awayDetector.js';
import { createApnsSender } from './notify/apns.js';
import { startPushNotifier } from './notify/pushNotifier.js';
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
const attach = new AttachRegistry({ log, bus }, config.attach.heartbeatMs);
const delivery = new PromptDelivery({ db, bus, log, runner, config, attach });
const continuation = new ContinuationRunner({ db, bus, log, delivery, config });

const watcher: ILimitWatcher | undefined = config.limitWatcher.enabled
  ? startLimitWatcher({ db, config, bus, log, continuation })
  : undefined;

const chatDelivery = config.chatDelivery.enabled
  ? startChatDelivery({ db, log, config, runner, bus, attach })
  : undefined;

const sessionReaper = startSessionReaper({ db, log, config, attach, runner });

const messageSummarizer = startMessageSummarizer({ db, bus, config, log });

const desktopNotifier = config.notifications.enabled
  ? startDesktopNotifier({ db, bus, config, log, attach })
  : undefined;

const awayDetector = config.push.enabled ? startAwayDetector({ config, log }) : undefined;
const apnsSender = config.push.enabled ? createApnsSender({ config, log }) : undefined;
const pushNotifier =
  awayDetector && apnsSender
    ? startPushNotifier({ db, bus, config, log, away: awayDetector, sender: apnsSender, attach })
    : undefined;

const hooksRoutes = buildHooksRoutes({
  config,
  db,
  bus,
  log,
  delivery,
  getWatcher: () => watcher,
  runner,
  attach,
  // `gateway` is constructed further below (after chat/athen wiring) — deferred via a getter,
  // same pattern as getWatcher above, so this doesn't need a reorder.
  getGateway: () => gateway,
});

const pokeChatDelivery = chatDelivery ? () => chatDelivery.pokeNow() : undefined;

const embedder = config.athen.embeddings
  ? createEmbedder({ config, log, modelCacheDir: join(projectRoot, 'data', 'models') })
  : undefined;
const athen = createAthen({ db, log, embedder });

// Ask-mode liveness: live = an open cc-attach terminal for the cwd, OR any instance at that cwd
// (default or a named sibling — several can share one cwd, see src/core/identity.ts) has a
// mid-turn session — anything else would only ever be reached via a fresh headless spawn.
function isLiveInstance(cwd: string): boolean {
  if (attach.get(cwd) !== undefined) return true;
  return instancesRepo.listByCwd(db, cwd).some((instance) => sessionsRepo.hasActiveSession(db, instance.id));
}

// Dispatch-mode liveness: whether a cc-attach wrapper is currently attached under this instance's
// resolved name (falling back to its cwd — see attachRegistry.ts's cwd-vs-name aggregation), and
// whether it's actively working right now. decideDispatch (src/spawn/dispatcher.ts) only reuses an
// attached-and-idle candidate.
function getInstanceLiveness(cwd: string, name: string): { attached: boolean; working: boolean } {
  const client = attach.getByName?.(name) ?? attach.get(cwd);
  return { attached: client !== undefined, working: attach.isWorking(cwd) };
}

const overlord = config.overlord.enabled
  ? createOverlord({ db, config, log, isLiveInstance, getInstanceLiveness })
  : undefined;

const terminalSpawner = config.terminalSpawn.enabled ? createTerminalSpawner({ config, log }) : undefined;
const dispatcher = terminalSpawner ? createDispatcher({ attach, spawner: terminalSpawner, config, db, log }) : undefined;

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
  attach,
  overlord,
  dispatcher,
  gateway,
});

const { app, injectWebSocket } = buildApp({
  config,
  db,
  bus,
  log,
  gateway,
  delivery,
  watcher,
  attach,
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
  sessionReaper.stop();
  messageSummarizer.stop();
  desktopNotifier?.stop();
  pushNotifier?.stop();
  apnsSender?.stop();
  awayDetector?.stop();
  attach.stop();
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
