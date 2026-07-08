# cc_hub — architecture and logic

Always-on Node hub coordinating multiple Claude Code (CC) instances on one machine. Three functions:

1. **Inter-instance chat + shared knowledge base** — CC sessions in different project dirs message each other (direct/broadcast) and share searchable notes, via MCP tools.
2. **Mobile monitoring/control API** — REST + WebSocket for a mobile client: watch sessions live, send prompts, answer permission requests remotely. Reachable on LAN directly, or from anywhere via an optional Cloudflare Worker relay.
3. **Limit watcher + auto-continue** — detects usage-limit interruptions via the (unofficial) usage API and auto-continues interrupted sessions after reset.

## Stack & conventions

- TypeScript, Node >= 22, ESM with NodeNext resolution — **local imports must end in `.js`**.
- No build step: runs via `tsx` (`npm start` / `npm run dev`), `tsc --noEmit` for typecheck, vitest for tests (co-located `*.test.ts`).
- Deps: Hono + @hono/node-server + @hono/node-ws (HTTP/WS), better-sqlite3 (SQLite + FTS5, WAL), @modelcontextprotocol/sdk (streamable HTTP MCP), ws, zod v3.
- Module pattern: factories/classes take a single deps object (`{ db, bus, log, config, ... }`); lifecycle objects return `{ stop() }`. One shared logger (`src/log.ts`, 1MB rename-rotate), messages prefixed `'module: text'`.
- HTTP error shape: `{ error: { code, message } }`.
- Config: `config.json` (gitignored) deep-merged over defaults in `src/config.ts`; no schema validation beyond fail-fast guards (authToken present; relay.url/secret required when relay.enabled). `config.example.json` mirrors the shape.

## Process layout (composition root: `src/index.ts`)

```
config → db (migrations) → bus → runner → delivery → continuation → watcher?
      → chatDelivery? → hooksRoutes → mcp gateway → apiRoutes → buildApp
      → serve(0.0.0.0:4270) → injectWebSocket → relay?
```

- `src/core/bus.ts` — `HubBus`, synchronous in-process fan-out of `HubEvent` (union in `src/types.ts`: session_event, session_status, message, permission_request, permission_decided, limit_state). Seam between ingest (hooks/API/MCP) and consumers (WS hub, future).
- `src/http/app.ts` — Hono assembly + auth middleware:
  - `/api/v1/*` — bearer token (constant-time compare against `config.authToken`).
  - `/ws` — bearer header OR `?token=` query.
  - `/hooks/*`, `/mcp` — **localhost-gated** by socket remoteAddress (127.0.0.1/::1 only). Never exposed to LAN/relay.
- `src/http/wsHub.ts` — subscribes to bus, fans frames out to WS clients. On connect sends `hello` snapshot (sessions + limit state); client `{"type":"ping"}` → `{"type":"pong","data":null}`.
- `src/db/` — migrations (versioned array in `migrations.ts`, `meta.schema_version`; **no CHECK constraints** — enums enforced in TS only) + one repo file per table under `db/repo/`.

## Identity model

Instance = project directory. `src/core/identity.ts`: name = cwd basename lowercased; collisions get parent-dir prefix, then numeric suffix. Two terminals in the same dir share one identity/inbox (documented simplification). Sessions (CC session uuids) belong to instances; MCP callers bind their `Mcp-Session-Id` to an instance via the `hub_register` tool (bindings are in-memory; re-register after hub restart).

## Function 1 — chat + KB (MCP, `src/mcp/`)

Endpoint `/mcp` (localhost only). Tools: `hub_register`, `chat_send` (omit `to` = broadcast), `chat_inbox`, `chat_peers`, `kb_add`, `kb_search` (FTS5 bm25, sanitized MATCH input), `kb_get`. Unregistered calls to tools 2–7 error with "call hub_register first".

**Message delivery to a recipient CC session** (messages are rows in `messages` + per-reader receipts in `message_reads`):

| Recipient state | Mechanism |
|---|---|
| Next user prompt | UserPromptSubmit hook injects unread as context, marks read |
| Turn end, urgent unread | Stop hook blocks with messages (`renderUrgentBlock`), marks read |
| Session start | Banner with unread count (not marked read) |
| **Idle** | **chatDelivery loop spawns a headless turn** (below) |

### Idle chat delivery (`src/chat/chatDelivery.ts`)

Watcher-style loop (recursive setTimeout, `ticking` guard, `pokeNow()`, `stop()`). Each tick (default 30s):
1. `listJoined({status:['idle']})`; keep most-recent idle session per instance; skip sessions idle longer than `maxSessionIdleAgeMinutes` (default 240).
2. Skip instances with no unread; skip sessions at the hourly cap — `countBySourceSince(session, 'chat', 1h)` over `pending_prompts` (default `maxPerSessionPerHour` 6; bounds ping-pong loops between two auto-replying instances).
3. Batch messages chronologically up to 20K chars (`MAX_BATCH_CHARS` — Windows CreateProcess argv limit ~32K; prompt is one `-p` arg); remainder delivered next tick.
4. `delivery.send(sessionId, renderChatDeliveryPrompt(batch), 'chat')`. Mark read: immediately for `queued` delivery (durably in prompt queue), for `spawned` only in the `onSettled(true)` callback — failed spawn leaves messages unread for retry under the cap.

## Function 2 — mobile API (`src/http/apiRoutes.ts`, `src/http/wsHub.ts`)

REST under `/api/v1`: health, sessions (+events, +prompt, +auto-continue), permissions (+decision), messages, kb, limit, debug/limit (debug logLevel only). No long-poll/SSE — realtime is `/ws` only. Prompt bodies capped 8000 chars.

**Remote prompt routing** (`src/runner/promptDelivery.ts`):
- Session `active` (or runner busy on it) → enqueue `pending_prompts(status='queued')`; drained by the next Stop hook via `claimForStopBlock` → block-with-reason ("execute it now").
- Session idle → enqueue `status='delivering'` + spawn `claude --resume <sid> -p "<prompt>" --output-format json` (`src/runner/claudeRunner.ts`: shell:false, cwd = session dir, 30-min kill timeout, one child per session, global cap 4). Spawn settles → row `delivered`/`failed`; optional `onSettled(ok)` callback for callers needing spawn confirmation (chat delivery uses it).
- Headless turns fire hooks like any turn, so status/events stay live; the interactive terminal does NOT repaint (known `--resume` limitation).

**Permission relay**: PermissionRequest hook → row + WS push → server long-polls up to `permissionWaitMs` (30s) for a REST decision → returns CC hook decision JSON (`composePermissionDecision` in `hooksRoutes.ts` isolates the CC-version-sensitive shape); timeout falls through to the terminal prompt.

## Function 3 — limit watcher (`src/limit/`)

- `usageClient.ts`: `GET api.anthropic.com/api/oauth/usage`, bearer from `~/.claude/.credentials.json` (re-read every call — CC rewrites it), header `anthropic-beta: oauth-2025-04-20`. Liberal parser (multiple key/format fallbacks). Error kinds: `auth`, `net`, `rate_limited` (429 → slow backoff).
- `watcher.ts` state machine, tick-driven (timers are optimization; tick check is authoritative → machine-sleep safe):
  `ok → limited` (util ≥ 95%: snapshot active/just-stopped sessions as `interrupted`) `→ waiting_reset` (resets_at known) `→ continuing` (past reset + jitter AND fresh poll confirms drop) `→ ok`. Any error → `unknown`. Util drop without action → candidates back to idle.
- `continuation.ts`: per interrupted session — skip if opted out (`auto_continue=0`), ended, or daily cap (3/day, `continues_date` rollover); serialized (`maxConcurrent` 1); sends `autoContinue.prompt` via delivery with `--permission-mode` from config.

## Hooks (`hooks/cc-hub-hook.mjs`, installed by `scripts/install-hooks.mjs`)

Zero-dep client: stdin JSON → POST `/hooks/event` → prints server's `stdout` field verbatim. **Fail-silent contract: any error (hub down, timeout, non-2xx) → print nothing, exit 0 — CC must never break when hub is down.** Installer APPEND-merges into `~/.claude/settings.json` (timestamped backup, idempotent). Events: SessionStart, UserPromptSubmit, Notification, Stop, PermissionRequest, SessionEnd (PostToolUse off by default). Stop handler order: loop-guard (`stop_hook_active`) → queued prompt block → urgent unread block → set idle.

## Cloudflare Worker relay (`worker/` + `src/relay/relayClient.ts`)

Optional remote access (`relay.enabled`, off by default). Hub is behind NAT → **hub dials OUT** a persistent WSS to the Worker; the Worker (single Durable Object `HubRelay`, `idFromName('hub')`) bridges internet clients to it. Nothing inbound through the home firewall.

- Edge (`worker/src/index.ts` default export): auth + routing only. `/connect` needs `x-hub-secret` = `HUB_SECRET`; `/ws` + `/api/v1/*` need bearer/`?token=` = `AUTH_TOKEN` (same value as hub authToken), constant-time. Everything else 404 — `/hooks`/`/mcp` structurally unreachable.
- DO uses the WebSocket Hibernation API (acceptWebSocket + tags/attachments, `setWebSocketAutoResponse` answers the wsHub-style ping at the edge) so idle relay costs nothing. Free plan requires the `new_sqlite_classes` migration in `wrangler.jsonc`.
- Protocol (JSON text frames, control key `t` — tunneled hub frames use `type`, so they stay opaque): worker→hub `req{id,method,path,headers,body}` / `ws_open{ch}` / `ws_msg{ch,data}` / `ws_close{ch}`; hub→worker `res{id,status,contentType,body}` / `ws_msg` / `ws_close`. Request timeout 30s at DO (504), 503 `hub_offline` when no hub socket, ~950KB body caps (DO WS 1 MiB frame limit).
- relayClient proxies `req` via `fetch('http://127.0.0.1:<port>' + path)` (25s timeout) and bridges each `ws_open` channel by dialing its own local `/ws?token=` — reuses wsHub/hello logic with zero server changes. Reconnect: exponential 1s→60s; attempt resets only after ≥30s stable uptime.
- **Security invariant**: relayed fetches originate from 127.0.0.1, so the hub's localhostGate would PASS for them — `isAllowedApiPath` (URL-normalized, must stay `/api/v1/` after normalization) is the guard keeping `/hooks`/`/mcp` unreachable. Don't weaken it.
- Deploy = user-run: `wrangler login` / `deploy` / `secret put AUTH_TOKEN` + `HUB_SECRET`, then fill `config.json` relay block (steps in README). Local `wrangler dev` does NOT work on this machine (workerd crashes with `std::terminate` on Win10 19042) — test the hub side against a protocol stub instead; the deployed worker runs on Cloudflare's runtime.

## Gotchas

- SQLite has **no CHECK constraints** here; status/source enums live only in `src/types.ts` unions. Adding a value = TS edit, no migration.
- New migration = append `{ version: N, sql }` to the array in `src/db/migrations.ts`.
- `mark_read` semantics: three writers (UserPromptSubmit all-unread, Stop urgent-only, chatDelivery batch) — any new delivery path must mark read or messages re-deliver forever.
- Broadcast purge requires receipts from ALL known instances (minus sender); fully-unread messages are never purged.
- Hook output JSON shapes (Stop block, PermissionRequest decision) drift across CC versions — composed server-side only (`hooksRoutes.ts`), hook script stays a dumb pipe.
- The usage endpoint is unofficial and intermittently 429s; watcher degrades to `unknown` and recovers — never false-continues (fresh-poll confirmation before continuing).
- `logs/`, `data/`, `config.json`, `worker/.dev.vars`, `.wrangler/` are gitignored; repo is public (github.com/righttechsoft/cc_hub) — no secrets/personal paths in committed files.

## Verify after changes

`npm run typecheck` && `npm test` (root), `npm run typecheck` in `worker/`. Live smoke harnesses (session scratchpad pattern): fake sessions via POST `/hooks/event`, prompts/messages via REST, watch `pending_prompts`/`message_reads` in `data/cc_hub.db` and `logs/cc_hub.log`.
