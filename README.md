# cc_hub

A local coordination hub for [Claude Code](https://code.claude.com/docs/en/overview). One always-on Node process that lets multiple Claude Code instances on the same machine talk to each other, be monitored and controlled from your phone, and automatically resume work after a usage-limit window resets.

**Three things it does:**

1. **Inter-instance chat + shared knowledge base** — Claude Code instances working in different project directories can message each other (direct or broadcast) and share searchable know-how notes ("here's how to set up mobile CI on GitHub") via MCP tools. Full-text search over the knowledge base, so an instance can check whether another instance already solved a problem before solving it from scratch.
2. **Remote monitoring / control API** — a REST + WebSocket surface for a companion mobile app: watch sessions live, send prompts to a session from your phone, answer permission requests remotely. LAN by default; an optional Cloudflare Worker relay (see below) extends the same API to the open internet without opening a port on your firewall.
3. **Usage-limit watcher + auto-continue** — polls Claude's usage API, detects "you've hit your usage limit — resets at HH:MM" windows, and automatically resumes the interrupted sessions once the limit resets (with safety caps).

> **Scope & platform:** built for a trusted personal LAN — one bearer token, normally over plain HTTP, not designed for internet exposure out of the box. The optional relay (see **Remote access**) carries that same single-bearer-token trust model out onto the internet, with the token checked at Cloudflare's edge over TLS rather than on your home network. Developed and tested on **Windows** (Node ≥ 22); the limit watcher reads Claude credentials via `%USERPROFILE%`, so other platforms need minor path adjustments.

## How it works

```
┌────────────┐  MCP (streamable HTTP, localhost)   ┌─────────────────┐
│ Claude Code │────────────────────────────────────▶│                 │
│ instance A  │  hooks (SessionStart/Stop/…)        │                 │
│ instance B  │────────────────────────────────────▶│     cc_hub      │──── SQLite + FTS5
│ instance …  │◀────context / block-decisions───────│  (one process)  │
└────────────┘                                      │                 │
      ▲          spawns `claude --resume <id> -p`   │                 │
      └─────────────────────────────────────────────│                 │
                                                    └───────┬─────────┘
                          REST + WebSocket (LAN, bearer)    │
                                                    ┌───────▼─────────┐
                                                    │   mobile app    │
                                                    └─────────────────┘
```

- **Hooks** installed in `~/.claude/settings.json` report session lifecycle events to the hub (turn-level only by default). The hook script is *fail-silent by contract*: if the hub is down it prints nothing and exits 0, so Claude Code behaves exactly as if no hook were installed.
- **Chat delivery** rides on those hooks while an instance is active: unread messages are injected as context at the start of the next turn; urgent messages and remotely queued prompts are delivered through a `Stop`-hook block, so the instance acts on them at the end of its current turn. Once an instance goes idle, a separate hub-side tick takes over — see **Idle chat delivery** below.
- **Remote prompts** to an idle session are delivered by spawning `claude --resume <session-id> -p "<prompt>"` headlessly — the turn lands in the same session transcript, and its hooks stream activity back to the hub (and your phone) in real time.
- **Permission requests** long-poll the hub for up to `permissionWaitMs` (default 30 s); answer from your phone, or let it fall through to the normal terminal prompt.
- **The limit watcher** is a tick-driven state machine (`ok → limited → waiting_reset → continuing → ok`) that survives machine sleep, backs off on API errors, and never auto-continues unless a fresh poll confirms the limit actually reset.

## Requirements

- Windows 10/11, Node.js ≥ 22
- [Claude Code](https://code.claude.com/docs/en/overview) CLI installed and logged in

## Quickstart

```powershell
git clone https://github.com/righttechsoft/cc_hub.git
cd cc_hub
npm install
npm run setup     # writes config.json (fresh authToken) + installs Claude Code hooks
npm start         # runs until Ctrl+C
```

`npm run setup` runs two idempotent steps (each can be run standalone):

- `node scripts/gen-token.mjs` — copies `config.example.json` to `config.json` with a fresh random `authToken`. No-ops if `config.json` already exists.
- `node scripts/install-hooks.mjs` — appends cc_hub's hook commands into `~/.claude/settings.json`. It only ever **appends**: existing hook groups are left untouched, a timestamped backup is written before any change, and re-running it skips events that already have a cc_hub entry.

For development, `npm run dev` runs the same entrypoint under `tsx watch`.

### Register the MCP server

With the hub running, register it once per machine (`--scope user` makes it available in every project):

```
claude mcp add --scope user --transport http cc-hub http://127.0.0.1:4270/mcp
```

The exact command (with your configured port) is printed to the log on every startup.

### Apply to already-running Claude Code sessions

Hooks and MCP config are snapshotted when a session starts. New sessions pick everything up automatically; for sessions already running, exit and resume with history intact:

```
claude --continue
```

## MCP tools

| Tool | What it does |
|---|---|
| `hub_register` | Bind this instance to the hub (call once per session, before other tools). Returns your instance name, unread count, and known peers |
| `chat_send` | Message another instance by name, or broadcast to all. `urgent: true` interrupts the recipient at its next turn end |
| `chat_inbox` | Fetch (and by default mark read) your unread messages |
| `chat_peers` | List known instances: name, project dir, last seen, active flag |
| `kb_add` | Save a reusable know-how note (title, body, tags) to the shared knowledge base |
| `kb_search` | Full-text search the knowledge base (FTS5 + BM25) |
| `kb_get` | Fetch a note's full body by id |

Instance identity is derived from the project directory (basename, with automatic disambiguation on collisions).

## Hook installer

```powershell
node scripts/install-hooks.mjs               # install (append-merge)
node scripts/install-hooks.mjs --dry-run     # show what would change, write nothing
node scripts/install-hooks.mjs --uninstall   # remove cc_hub's entries only
```

Installed events: `SessionStart`, `UserPromptSubmit`, `Notification`, `Stop`, `PermissionRequest`, `SessionEnd`. `PostToolUse` (per-tool-call activity) is **not** installed by default — see `hooks.postToolUse` in the config to opt in.

The hook script (`hooks/cc-hub-hook.mjs`) has zero dependencies and never breaks Claude Code: any error — hub down, timeout, unexpected response — results in no output and exit 0. Environment overrides: `CC_HUB_URL` for a non-default host/port, `CC_HUB_DEBUG=1` to log to `%LOCALAPPDATA%\cc_hub\hook.log`.

## REST API

Base URL: `http://<lan-ip>:<port>/api/v1`. Every request needs `Authorization: Bearer <authToken>` (from `config.json`); there is no unauthenticated endpoint.

| Method & path | Body | Notes |
|---|---|---|
| `GET /health` | — | `{status, uptimeMs, limit}` |
| `GET /sessions?status=` | — | `status` is a comma-separated list (`active,idle,...`) |
| `GET /sessions/:id` | — | Session + `instance_name`, `pendingPrompts`, last 20 `events` |
| `GET /sessions/:id/events?afterId&limit` | — | Paginate forward from `afterId` (default 0), `limit` default 100, max 500 |
| `POST /sessions/:id/prompt` | `{prompt}` | `{delivery:"spawned"\|"queued", pendingPromptId}`; 409 if session has ended |
| `POST /sessions/:id/auto-continue` | `{enabled}` | Toggle auto-continue for one session |
| `GET /permissions?status=` | — | `status` one of `pending\|allowed\|denied\|timeout` |
| `POST /permissions/:id/decision` | `{behavior:"allow"\|"deny", message?}` | 409 if already decided (someone else / timeout got there first) |
| `GET /messages?limit&beforeId` | — | Chat history, newest first |
| `POST /messages` | `{to?, body, urgent?}` | `from_name` is always forced to `"mobile"`; omit `to` to broadcast |
| `GET /kb/search?q=&limit=` | — | Full-text search over the shared knowledge base |
| `GET /kb/:id` | — | Full note body |
| `POST /kb` | `{title, body, tags?}` | Author is forced to `"mobile"` |
| `GET /limit` | — | Current `limit_state` row + last 20 `limit_events` |
| `POST /debug/limit` | `{state, resetsAtMs?}` | Dev-only (gated on `logLevel:"debug"`); forces the watcher's state for testing |

### WebSocket

`ws://<lan-ip>:<port>/ws` — auth via `Authorization: Bearer <token>` header **or** `?token=<token>` query param (for WS clients that can't set headers).

Server → client frames (`{type, data}`):

| type | data |
|---|---|
| `hello` | Sent once on connect: `{sessions, limit}` snapshot |
| `session_event` | `{sessionId, eventType, payload, createdAt}` |
| `session_status` | `{sessionId, status}` |
| `message` | A chat message row |
| `permission_request` | A newly pending permission request |
| `permission_decided` | Allowed / denied / timed out |
| `limit_state` | Limit watcher state change |

Client → server: `{"type":"ping"}` → `{"type":"pong","data":null}`.

`/hooks/*` and `/mcp` are **not** part of this API — they are restricted to localhost by socket address, used by the hook script and `claude mcp add` respectively.

## Auto-continue

When the watcher sees five-hour utilization cross `limitedThresholdPct`, it snapshots which sessions were mid-work ("interrupted"). Once `resets_at` passes (plus `resetJitterMs`) *and* a fresh poll confirms utilization dropped, each interrupted session is resumed headlessly with `autoContinue.prompt`. Guard rails:

- `maxPerSessionPerDay` (default 3) — a session that keeps hitting the limit won't loop forever
- `maxConcurrent` (default 1) — resumes are serialized
- per-session opt-out via `POST /sessions/:id/auto-continue` or the `auto_continue` flag
- any watcher error degrades to an `unknown` state that never auto-continues blind

## Idle chat delivery

Without this, a message reaches its recipient at one of three moments: injected as context at its next prompt, pushed through the `Stop` hook if it's urgent, or summarized in the banner at session start. That leaves a gap for an instance that's simply gone idle — no more turns coming, so nothing to inject context into. To close it, the hub ticks every `chatDelivery.tickMs` (default 30 s); for each idle session that's sitting on unread messages, it spawns a headless turn (`claude --resume <session-id> -p "..."`) carrying those messages plus an instruction to act on them or reply via `chat_send`. Messages delivered this way are marked read as part of the delivery.

Guard rails:

- `chatDelivery.maxPerSessionPerHour` (default 6) caps idle-delivery turns per session per hour, so two chatty instances can't bounce messages back and forth into a delivery loop.
- `chatDelivery.maxSessionIdleAgeMinutes` (default 240) skips sessions that have been idle longer than that — long-abandoned sessions don't get woken up just to read a message.
- `chatDelivery.enabled: false` turns the tick off entirely; context-injection and `Stop`-hook delivery to active instances keep working as before.

A headless turn spawned this way consumes usage like any other turn, and — same caveat as auto-continue — it won't repaint an interactive terminal left open on that session; the turn lands in the transcript and streams to the hub in real time, but the visible terminal doesn't refresh (see Limitations).

## Configuration reference

`config.json` (gitignored; generated from `config.example.json` by `npm run setup`):

| Key | Meaning |
|---|---|
| `port` | HTTP port (default `4270`) |
| `bindAddress` | Interface to bind (`0.0.0.0` = all interfaces, needed for LAN access) |
| `authToken` | Bearer token for `/api/v1/*` and `/ws`. Generated by `gen-token.mjs`; treat as a secret |
| `claudePath` | Path to the `claude` executable (bare `claude` resolves via `PATH`) |
| `hooks.postToolUse` | Record `PostToolUse` events (off by default — turn-level only) |
| `hooks.postToolUseThrottleMs` | Min gap between recorded `PostToolUse` events per session, if enabled |
| `hooks.permissionWaitMs` | How long the `PermissionRequest` hook long-polls for a remote decision before falling back to the terminal prompt |
| `limitWatcher.enabled` | Turn the usage-limit poller on/off |
| `limitWatcher.pollIntervalMs` | Normal poll cadence |
| `limitWatcher.retryIntervalMs` | Poll cadence after a transient (network) failure |
| `limitWatcher.limitedThresholdPct` | Five-hour utilization % that counts as "limited" |
| `limitWatcher.resetJitterMs` | Extra delay after `resets_at` before trusting the reset |
| `autoContinue.enabled` | Master switch for auto-resuming interrupted sessions |
| `autoContinue.prompt` | The prompt sent to resume an interrupted session |
| `autoContinue.maxPerSessionPerDay` | Safety cap per session per local calendar day |
| `autoContinue.maxConcurrent` | How many sessions to auto-continue at once |
| `autoContinue.eligibleWindowMinutes` | How recently a session must have been active to count as "interrupted" |
| `autoContinue.permissionMode` | `--permission-mode` passed to the headless `claude --resume` call |
| `retention.sessionEventsDays` | `session_events` rows older than this are purged daily |
| `retention.messagesDays` | Read messages older than this are purged daily (unread messages are never auto-deleted) |
| `relay.enabled` | Turn on the Cloudflare Worker relay for remote (off-LAN) access (default `false`) |
| `relay.url` | The deployed worker's URL, e.g. `https://cc-hub-relay.<account>.workers.dev` |
| `relay.secret` | Shared secret the hub authenticates to the worker with (the `HUB_SECRET` set via `wrangler secret put`) |
| `chatDelivery.enabled` | Master switch for idle chat delivery (default `true`) |
| `chatDelivery.tickMs` | How often the hub checks idle sessions for unread messages (default `30000`) |
| `chatDelivery.maxPerSessionPerHour` | Cap on idle-delivery turns per session per hour (default `6`) |
| `chatDelivery.maxSessionIdleAgeMinutes` | Sessions idle longer than this are skipped by idle delivery (default `240`) |
| `logLevel` | `debug\|info\|warn\|error` |

## Firewall & autostart

Allow LAN devices to reach the hub:

```powershell
netsh advfirewall firewall add rule name="cc_hub" dir=in action=allow protocol=TCP localport=4270 remoteip=localsubnet
```

Run from login via Task Scheduler (or use any process manager you prefer):

```powershell
schtasks /create /tn cc_hub /sc onlogon /tr "cmd /c cd /d C:\path\to\cc_hub && npm start" /rl limited
```

## Remote access (Cloudflare Worker relay)

Everything above assumes your phone is on the same LAN as the hub. The optional relay lifts that restriction: the hub dials *out* to a small Cloudflare Worker (backed by a Durable Object) and holds that connection open, and your mobile client talks to the worker instead of talking to the hub directly. There's nothing to open on your home firewall — no port forward, no inbound rule — because the connection is always initiated from inside your network outward.

The worker only knows how to forward two things, `/api/v1/*` and `/ws`; it has no route for `/hooks` or `/mcp`, so those stay reachable only from localhost exactly as before. The hub's relay client enforces the same boundary independently, allowlisting `/api/v1/` on its own side of the tunnel — so even a misconfigured or compromised worker deployment can't get the hub to relay anything else.

```
┌──────────────┐   dials out: persistent WebSocket    ┌───────────────────┐
│    cc_hub    │─────────────────────────────────────▶│                   │
│ (behind your │                                       │ Cloudflare Worker │
│  firewall,   │◀─────────────────────────────────────│ + Durable Object  │
│ no inbound   │   REST + WS tunneled over that socket │  (cc-hub-relay)   │
│    rules)    │                                       │                   │
└──────────────┘                                       └─────────┬─────────┘
                                    HTTPS / wss:// (bearer token)  │
                                              anywhere             │
                                                          ┌─────────▼─────────┐
                                                          │     mobile app     │
                                                          └───────────────────┘
```

### Deploy the worker

1. `cd worker && npm install`
2. `npx wrangler login` — one-time OAuth login to your Cloudflare account.
3. `npx wrangler deploy` — note the URL it prints, `https://cc-hub-relay.<account>.workers.dev`.
4. `npx wrangler secret put AUTH_TOKEN` — paste in the same `authToken` value from your hub's `config.json`.
5. Generate a second, independent secret and set it too: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`, then `npx wrangler secret put HUB_SECRET` and paste in the output.
6. Point the hub at the deployed worker by adding a `relay` block to `config.json`:
   ```json
   "relay": { "enabled": true, "url": "https://cc-hub-relay.<account>.workers.dev", "secret": "<the HUB_SECRET value>" }
   ```
7. Restart the hub — the log should show `relay: connected`.

### Local development

To iterate on the worker itself without deploying, run `wrangler dev` against a `worker/.dev.vars` file (gitignored) containing `AUTH_TOKEN` and `HUB_SECRET`, and point the hub's `relay.url` at `http://127.0.0.1:8787` instead of the deployed URL.

### Client behavior

Mobile clients use the same `/api/v1/*` paths and the same bearer token whether they're talking to the hub directly or through the relay. The recommended pattern is to probe the LAN hub's `/api/v1/health` with a short (1-2 s) timeout first, and fall back to the worker URL if that probe fails or times out. `/ws` behaves identically over the relay, including `?token=` query-param auth for clients that can't set headers, and the `{"type":"ping"}` keepalive — the edge answers it directly when the connection is relayed, without a round trip to the hub. Query-string tokens can be captured in Cloudflare request logs (observability/tail), so prefer the `Authorization` header for `/ws` when the client supports setting WebSocket headers; `?token=` remains for clients that cannot.

### Limits

- Request and message bodies are capped at roughly 950 KB, the practical ceiling under the Durable Object WebSocket's 1 MiB frame limit. That's well above what's ever needed in practice — prompts sent through cc_hub are already capped at 8000 characters.
- The free Workers tier is plenty for single-user use; WebSocket hibernation keeps the Durable Object's idle cost at zero between messages.
- The worker returns `503 hub_offline` if no hub is currently connected, and `504 hub_timeout` if a connected hub doesn't answer within 30 s.
- Run exactly one hub per worker deployment — the relay assumes a single connected hub and doesn't multiplex requests across several.

## Development

```powershell
npm run dev          # tsx watch
npm run typecheck    # tsc --noEmit
npm test             # vitest (limit watcher state machine, continuation caps, usage parsing)
```

No build step — the server runs from TypeScript sources via `tsx`. SQLite database lives in `data/`, logs in `logs/` (both gitignored).

## Limitations

- **Instance identity is per-directory, not per-terminal.** Two terminals open in the same project directory share one inbox and one instance identity.
- **A headless `--resume` turn does not repaint an open interactive terminal.** The turn lands in the session transcript and hooks stream it to the hub in real time, but the visible terminal won't refresh — there is no supported way to type into a running interactive terminal remotely.
- **Security model is a single static bearer token, not a full auth system.** By default it's checked over plain HTTP on your LAN — adequate for a trusted home network, nothing more. The optional relay (see **Remote access**) carries the same single-bearer-token trust model onto the internet, just with the token checked at Cloudflare's edge over TLS instead of on your home network — it doesn't add per-user accounts or scoped permissions. `/hooks` and `/mcp` are additionally restricted to localhost regardless of the token, and the relay has no route to either of them.
- **The usage endpoint (`/api/oauth/usage`) is unofficial and undocumented.** Parsing is deliberately liberal, and any failure degrades the watcher to `unknown` rather than guessing — but the endpoint may change or disappear at any time.
- **Hook output formats drift across Claude Code versions.** The `Stop`-block and `PermissionRequest` decision shapes are pinned to current Claude Code and isolated in one function each, but a CC upgrade may require touching them.

## Disclaimer

This is an unofficial community tool, not affiliated with or endorsed by Anthropic. It automates your own Claude Code sessions on your own machine using your own credentials; the auto-continue feature consumes your plan's usage as if you had typed "continue" yourself.

## License

[MIT](LICENSE) © Right Tech Soft LLC
