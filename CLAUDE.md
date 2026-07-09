# cc_hub — architecture and logic

Always-on Node hub coordinating multiple Claude Code (CC) instances on one machine. Three functions:

1. **Inter-instance chat + Athen (shared know-how store)** — CC sessions in different project dirs message each other (direct/broadcast) and share know-how notes searchable by meaning (local embeddings + FTS), via MCP tools.
2. **Mobile monitoring/control API** — REST + WebSocket for a mobile client: watch sessions live, send prompts, answer permission requests remotely. Reachable on LAN directly, or from anywhere via an optional Cloudflare Worker relay.
3. **Limit watcher + auto-continue** — detects usage-limit interruptions via the (unofficial) usage API and auto-continues interrupted sessions after reset.

## Stack & conventions

- TypeScript, Node >= 22, ESM with NodeNext resolution — **local imports must end in `.js`**.
- No build step: runs via `tsx` (`npm start` / `npm run dev`), `tsc --noEmit` for typecheck, vitest for tests (co-located `*.test.ts`).
- Deps: Hono + @hono/node-server + @hono/node-ws (HTTP/WS), better-sqlite3 (SQLite + FTS5, WAL), @modelcontextprotocol/sdk (streamable HTTP MCP), ws, zod v3, @huggingface/transformers + sqlite-vec (both pinned exact — native-adjacent; local embeddings + vector KNN for Athen).
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

## Function 1 — chat + Athen (MCP, `src/mcp/`)

Endpoint `/mcp` (localhost only). Tools: `hub_register`, `chat_send` (omit `to` = broadcast), `chat_inbox`, `chat_peers`, `athen_save`, `athen_search`, `athen_get`. Unregistered calls to tools 2–7 error with "call hub_register first".

### Athen — semantic know-how store (`src/kb/athen.ts`, `src/kb/embedder.ts`)

Athen (= *Athenaeum*, a library of collected knowledge) is the machine-wide memory shared by all instances: one instance saves an instruction ("save how to build an iOS app to athen"), any other finds it later by meaning ("does athen know about shipping iPhone apps" → the "Building iOS apps" note, zero keyword overlap). Technically it's the KB upgraded: same `kb_notes` table + `kb_fts` (FTS5 `porter unicode61`, bm25-weighted title/tags/body, sanitized **OR-joined** MATCH — any query word can hit; bm25 still ranks multi-word matches higher), plus local embeddings for search by meaning. HTTP routes keep their `/kb/*` paths (mobile app compatibility) but go through the same `Athen` service.

- **Embedder** (`embedder.ts`): transformers.js feature-extraction pipeline, default `Xenova/all-MiniLM-L6-v2` (384-dim, q8, L2-normalized), lazy-loaded on first `embed()` via dynamic `import()` (a static import would crash the hub if the onnxruntime binary can't load). Model cache: `data/models/` (gitignored), ~25MB download on first use. Init failure warns once, nulls the init promise (later calls retry — covers offline boot), rethrows.
- **Vector store**: `kb_vec` vec0 virtual table (sqlite-vec), `note_id INTEGER PRIMARY KEY, embedding float[<dim>]`. Created **at runtime by athen, NOT in the migrations array** — the extension must be loaded into the connection before the DDL runs, and migrations must stay runnable when the .dll fails to load. Dim comes from actual model output. Meta key `athen_vec_model` tracks which model the vectors belong to; mismatch (config model change) → `DROP TABLE` + recreate + backfill re-embeds everything. Not transactional; crash mid-way self-heals (stale meta reads as mismatch).
- **save**: `kb.add` (sync — note always persists) → embed `title\ntags\nbody[:2000]` → `upsertVec`. Embed failure = warn only; the note stays FTS-findable and the backfill retries it.
- **search**: hybrid — FTS leg + KNN leg (each pool `max(20, limit)`), fused by reciprocal rank (`rrfMerge`, score = Σ 1/(60+rank), higher = better). Semantic-only hits hydrate via `kb.get` with body-head snippet. Any missing piece (no embedder, extension load failed, model mismatch, embed throw) → plain FTS results, exact old shape — **search never breaks**. `KbSearchResult.rank` semantics differ per path (bm25 lower-better vs RRF higher-better); only ordering is meaningful, mobile never sorts by it.
- **Backfill**: one-shot unref'd `setTimeout(10s)` after `createAthen` — embeds notes missing vectors (pre-existing rows, failed saves, model switches) in batches of 16; aborts on first error (retries next hub start). Bootstraps `kb_vec` from a probe embedding when it doesn't exist yet.
- **Kill switch**: `athen.embeddings: false` in config → no embedder constructed, pure FTS.

**Message delivery to a recipient CC session** (messages are rows in `messages` + per-reader receipts in `message_reads`):

| Recipient state | Mechanism |
|---|---|
| Next user prompt | UserPromptSubmit hook injects unread as context, marks read |
| Turn end, urgent unread | Stop hook blocks with messages (`renderUrgentBlock`), marks read |
| Session start | Banner with unread count (not marked read) |
| **Idle** | **chatDelivery loop spawns a headless turn** (below) |

### Idle chat delivery (`src/chat/chatDelivery.ts`)

Watcher-style loop (recursive setTimeout, `ticking` guard, `pokeNow()`, `stop()`). `chat_send` (MCP) and `POST /api/v1/messages` both call `pokeNow()` after inserting the message (optional `pokeChatDelivery` dep wired in `index.ts`), so idle recipients get mail near-instantly instead of on the next poll tick. Each tick (default 30s):
1. `listJoined({status:['idle']})`; keep most-recent idle session per instance; skip sessions idle longer than `maxSessionIdleAgeMinutes` (default 0 = no age limit; set >0 to skip stale sessions) **or** idle for less than `minIdleMinutes` (default 0 = off) — the latter, when enabled, gates against a human still sitting at the interactive terminal (a headless `--resume` turn never repaints it, so they'd never see the delivery — the FYI re-surface below is the default-config mitigation).
2. Skip instances with no unread; skip sessions at the hourly cap — `countBySourceSince(session, 'chat', 1h)` over `pending_prompts` (default `maxPerSessionPerHour` 20; bounds ping-pong loops between two auto-replying instances).
3. Batch messages chronologically up to 20K chars (`MAX_BATCH_CHARS` — Windows CreateProcess argv limit ~32K; prompt is one `-p` arg); remainder delivered next tick.
4. `delivery.send(sessionId, renderChatDeliveryPrompt(batch), 'chat')`. Mark read: immediately for `queued` delivery (durably in prompt queue), for `spawned` only in the `onSettled(true)` callback — failed spawn leaves messages unread for retry under the cap. Both mark-read calls pass `via: 'chat_delivery'` on the `message_reads` row. In practice, for a `spawned` delivery this call is usually a no-op: the headless turn's own `UserPromptSubmit` fires first (mid-turn, before `onSettled`) and already wrote the same `via='chat_delivery'` row — see below.

**FYI re-surface** (`src/http/hooksRoutes.ts` `handleUserPromptSubmit`): even with the `minIdleMinutes` gate, a human could return to the terminal and type a prompt before ever seeing a delivery that already happened. `handleUserPromptSubmit` first checks `runner.isRunning(sess.id)` — true for exactly the lifetime of a hub-spawned headless child process — to tell a human-typed prompt apart from the hub's own spawned turn:
  - If the turn **is** hub-spawned, its unread-mark-read write is tagged `via='chat_delivery'` (instead of `NULL`) so the messages become eligible for re-surfacing, and the FYI query/flip below is skipped entirely (a headless turn must never be the one to consume the one-shot).
  - If the turn is a real human prompt, the hub queries `listChatDeliveredUnnotified` (rows in `message_reads` with `via = 'chat_delivery'`, no time bound) and, if any exist, appends `renderChatDeliveredFyi` to the injected context and flips their `via` to `chat_delivery_notified` via `markChatDeliveryNotified` — one-shot by construction, since the flip removes them from the next query.

## Function 2 — mobile API (`src/http/apiRoutes.ts`, `src/http/wsHub.ts`)

REST under `/api/v1`: health, sessions (+events, +prompt, +auto-continue), permissions (+decision), messages, kb, limit, debug/limit (debug logLevel only). No long-poll/SSE — realtime is `/ws` only. Prompt bodies capped 8000 chars.

**Remote prompt routing** (`src/runner/promptDelivery.ts`):
- Session `active` (or runner busy on it) → enqueue `pending_prompts(status='queued')`; drained by the next Stop hook via `claimForStopBlock` → block-with-reason ("execute it now").
- Session idle → enqueue `status='delivering'` + spawn `claude --resume <sid> -p "<prompt>" --output-format json` (`src/runner/claudeRunner.ts`: shell:false, cwd = session dir, 30-min kill timeout, one child per session, global cap 4). Spawn settles → row `delivered`/`failed`; optional `onSettled(ok)` callback for callers needing spawn confirmation (chat delivery uses it).
- Headless turns fire hooks like any turn, so status/events stay live; the interactive terminal does NOT repaint (known `--resume` limitation).

**Permission relay**: PermissionRequest hook → row + WS push → server long-polls up to `permissionWaitMs` (30s) for a REST decision → returns CC hook decision JSON (`composePermissionDecision` in `hooksRoutes.ts` isolates the CC-version-sensitive shape); timeout falls through to the terminal prompt.

`POST /sessions` spawns a brand-new headless session (`claude -p "<prompt>"`, no `--resume`) in a given `cwd`; fire-and-forget — 202 `{spawned:true}` once `runner.startNew()` is kicked off, the session self-registers via the SessionStart hook once it starts.

## Function 3 — limit watcher (`src/limit/`)

- `usageClient.ts`: `GET api.anthropic.com/api/oauth/usage`, bearer from `~/.claude/.credentials.json` (re-read every call — CC rewrites it), header `anthropic-beta: oauth-2025-04-20`. Liberal parser (multiple key/format fallbacks). Error kinds: `auth`, `net`, `rate_limited` (429 → slow backoff).
- `watcher.ts` state machine, tick-driven (timers are optimization; tick check is authoritative → machine-sleep safe):
  `ok → limited` (util ≥ `limitedThresholdPct`, default 100: snapshot active/just-stopped sessions as `interrupted`) `→ waiting_reset` (resets_at known) `→ continuing` (past reset + jitter AND fresh poll confirms drop) `→ ok`. Any error → `unknown`. Util drop without action → candidates back to idle. Detection is global-account only (usage API) — no per-session limit signals.
- **Continue-time transcript scan** (`transcriptScan.ts`, runs inside `enterContinuing` before targets are built): the `→limited` snapshot only covers sessions active/idle-<5min at detection time; idle sessions whose turn was killed by the limit — however long ago, including while the hub was down mid-window — are found by reading the last 64KB of each idle session's `transcript_path` for a limit marker (`LIMIT_MARKER_RE`) **on a line that also contains `"isApiErrorMessage":true` or `"type":"system"`** (plain conversation *about* limits must not match). Marker must be fresh: line `"timestamp"` (or file mtime fallback) within `autoContinue.transcriptScanWindowMinutes` (default 360); files with older mtime are skipped unread. Hits get `markInterrupted` and join the normal continuation flow. Fail-soft per file and per scan (stubbed via `WatcherIo.scanTranscripts` in tests). Known edge: hub restarting *after* the reset already passed goes `unknown→ok` and never scans — those sessions wait for the next limit cycle.
- `continuation.ts`: per interrupted session — skip if opted out (`auto_continue=0`), ended, or daily cap (`maxPerSessionPerDay`, `<=0` = unlimited — the default 0; `continues_date` rollover); serialized (`maxConcurrent` 1); sends `autoContinue.prompt` via delivery with `--permission-mode` from config.

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
- New migration = append `{ version: N, sql }` to the array in `src/db/migrations.ts`. **Exception: `kb_vec`** is a vec0 virtual table created at runtime by athen init, deliberately NOT in the migrations array — the sqlite-vec extension must be loaded first, and the hub must boot without it.
- vec0's xUpdate rejects better-sqlite3's number binding for the PK ("Only integers are allows for primary key values") — `upsertVec` binds `BigInt(noteId)`. Number binds are fine for `WHERE note_id = ?`, `k = ?`, and returned `note_id` values.
- `mark_read` semantics: three writers (UserPromptSubmit all-unread, Stop urgent-only, chatDelivery batch) — any new delivery path must mark read or messages re-deliver forever. `message_reads.via` records which writer did it: `'chat_delivery'`, flipped to `'chat_delivery_notified'` once FYI-surfaced. UserPromptSubmit writes `'chat_delivery'` too, but *only* when `runner.isRunning(sess.id)` (i.e. it's firing inside a hub-spawned headless turn, not a human's own prompt) — otherwise it leaves `via` `NULL`, same as Stop's urgent-only writer. Getting this via-tagging wrong reintroduces a real bug: since `markRead` is `INSERT OR IGNORE`, whichever writer marks a message read *first* wins, and the headless turn's own UserPromptSubmit always fires before chatDelivery's `onSettled`/queued writer.
- Broadcast purge requires receipts from ALL known instances (minus sender); fully-unread messages are never purged.
- New-session headless turns (`POST /sessions` → `runner.startNew`) are keyed synthetically (`` `new:<n>` ``) in `ClaudeRunner`'s running map, not by session id — so `runner.isRunning(sessionId)` is false for them. If spawned into a dir whose instance already has unread messages, that turn's UserPromptSubmit marks them read with `via=NULL` (the human path), not `via='chat_delivery'`. Rare, accepted.
- Hook output JSON shapes (Stop block, PermissionRequest decision) drift across CC versions — composed server-side only (`hooksRoutes.ts`), hook script stays a dumb pipe.
- The usage endpoint is unofficial and intermittently 429s; watcher degrades to `unknown` and recovers — never false-continues (fresh-poll confirmation before continuing).
- `logs/`, `data/`, `config.json`, `worker/.dev.vars`, `.wrangler/` are gitignored; repo is public (github.com/righttechsoft/cc_hub) — no secrets/personal paths in committed files.

## Verify after changes

`npm run typecheck` && `npm test` (root), `npm run typecheck` in `worker/`. Live smoke harnesses (session scratchpad pattern): fake sessions via POST `/hooks/event`, prompts/messages via REST, watch `pending_prompts`/`message_reads` in `data/cc_hub.db` and `logs/cc_hub.log`.
