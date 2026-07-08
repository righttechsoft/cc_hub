# cc_hub

A local coordination hub for [Claude Code](https://code.claude.com/docs/en/overview). One always-on Node process that lets multiple Claude Code instances on the same machine talk to each other, be monitored and controlled from your phone, and automatically resume work after a usage-limit window resets.

**Three things it does:**

1. **Inter-instance chat + shared knowledge base** — Claude Code instances working in different project directories can message each other (direct or broadcast) and share searchable know-how notes ("here's how to set up mobile CI on GitHub") via MCP tools. Full-text search over the knowledge base, so an instance can check whether another instance already solved a problem before solving it from scratch.
2. **Remote monitoring / control API** — a REST + WebSocket surface (LAN-only) for a companion mobile app: watch sessions live, send prompts to a session from your phone, answer permission requests remotely.
3. **Usage-limit watcher + auto-continue** — polls Claude's usage API, detects "you've hit your usage limit — resets at HH:MM" windows, and automatically resumes the interrupted sessions once the limit resets (with safety caps).

> **Scope & platform:** built for a trusted personal LAN — one bearer token over plain HTTP, not designed for internet exposure. Developed and tested on **Windows** (Node ≥ 22); the limit watcher reads Claude credentials via `%USERPROFILE%`, so other platforms need minor path adjustments.

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
- **Chat delivery** rides on those hooks: unread messages are injected as context at the start of the next turn; urgent messages and remotely queued prompts are delivered through a `Stop`-hook block, so the instance acts on them at the end of its current turn.
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
- **Security model is LAN-only.** A single static bearer token over plain HTTP — adequate for a trusted home network, nothing more. `/hooks` and `/mcp` are additionally restricted to localhost regardless of the token.
- **The usage endpoint (`/api/oauth/usage`) is unofficial and undocumented.** Parsing is deliberately liberal, and any failure degrades the watcher to `unknown` rather than guessing — but the endpoint may change or disappear at any time.
- **Hook output formats drift across Claude Code versions.** The `Stop`-block and `PermissionRequest` decision shapes are pinned to current Claude Code and isolated in one function each, but a CC upgrade may require touching them.

## Disclaimer

This is an unofficial community tool, not affiliated with or endorsed by Anthropic. It automates your own Claude Code sessions on your own machine using your own credentials; the auto-continue feature consumes your plan's usage as if you had typed "continue" yourself.

## License

[MIT](LICENSE) © Right Tech Soft LLC
