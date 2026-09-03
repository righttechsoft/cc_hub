// Shared contract types for cc_hub. Every module imports from here — keep in sync with
// src/db/migrations.ts (schema) and the plan's DB / bus sections.
import type { WSContext } from 'hono/ws';

export type SessionStatus = 'active' | 'idle' | 'ended' | 'interrupted' | 'continuing';

export type LimitStateName = 'ok' | 'limited' | 'waiting_reset' | 'continuing' | 'unknown';

export type PendingPromptSource = 'mobile' | 'limit_watcher' | 'api' | 'chat';

export type PendingPromptStatus = 'queued' | 'delivering' | 'delivered' | 'failed' | 'cancelled';

export type PermissionStatus = 'pending' | 'allowed' | 'denied' | 'timeout';

// Provenance of an instance's `name` (migration v8's `name_source` column, default 'cwd'):
// 'cwd' = derived from the folder name (instanceNameFromCwd, the pre-existing default); 'explicit'
// = a deliberate identity set via cc-attach --name / CC_HUB_NAME / hub_register's `name` arg / the
// admin ✎ rename; 'session' = auto-adopted from Claude Code's own `/name` session title (see
// src/core/sessionNameIdentity.ts). Adoption (src/http/hooksRoutes.ts's session-name route) only
// ever proceeds when the current source is 'cwd' or 'session' — never silently overriding an
// 'explicit' identity. See src/core/identity.ts's applyInstanceRename.
export type InstanceNameSource = 'cwd' | 'explicit' | 'session';

export interface HubConfig {
  port: number;
  bindAddress: string;
  authToken: string;
  claudePath: string;
  hooks: {
    postToolUse: boolean;
    postToolUseThrottleMs: number;
    permissionWaitMs: number;
  };
  limitWatcher: {
    enabled: boolean;
    pollIntervalMs: number;
    retryIntervalMs: number;
    limitedThresholdPct: number;
    resetJitterMs: number;
  };
  autoContinue: {
    enabled: boolean;
    prompt: string;
    maxPerSessionPerDay: number;
    maxConcurrent: number;
    eligibleWindowMinutes: number;
    transcriptScanWindowMinutes: number;
    permissionMode: string;
  };
  retention: {
    sessionEventsDays: number;
    messagesDays: number;
  };
  relay: { enabled: boolean; url: string; secret: string };
  chatDelivery: {
    enabled: boolean;
    tickMs: number;
    maxSpawnsPerInstancePerHour: number;
  };
  summaries: {
    enabled: boolean;
    model: string;
  };
  attach: {
    enabled: boolean;
    heartbeatMs: number;
    // Smart-paste hygiene (see src/attach/pasteHygiene.ts) — applied to clipboard text before it's
    // injected as a non-submitting bracketed paste, so the human reviews the transformed result.
    redactSecrets: boolean;
    fenceCodePastes: boolean;
    // Snippets / prompt macros (see src/attach/snippets.ts): single-char key -> canned text,
    // expanded by pressing the Ctrl+G leader then that key. Empty by default — the feature is
    // fully inert (Ctrl+G untouched) until at least one entry is configured. Optional (rather than
    // defaulted like its siblings above) so existing HubConfig fixtures across the test suite
    // don't all need updating for a field only src/attach/cli.ts's own config reader consumes.
    snippets?: Record<string, string>;
  };
  athen: {
    // Kill switch for local embeddings (onnxruntime/sqlite-vec load failure, offline machine).
    // Off = athen_search degrades to FTS-only; notes are never lost either way.
    embeddings: boolean;
    // Changing the model drops and rebuilds the vector table (old vectors are garbage for a
    // new model); notes re-embed via the startup backfill.
    model: string;
  };
  overlord: {
    enabled: boolean;
    model: string;
    // How far back (days, by mtime) to scan ~/.claude/projects transcripts for a match.
    transcriptDays: number;
    // How much of each transcript's tail (KB) to read/search — mirrors src/limit/transcriptScan.ts.
    tailKb: number;
  };
  // AI Overlord's "dispatch" mode (src/overlord/overlord.ts) + the underlying wt.exe tab-opener
  // (src/spawn/terminalSpawner.ts) — assigns a task to a project by reusing an idle attached
  // cc-attach terminal, or opening a brand-new one when none is available. Windows-only; a no-op
  // everywhere else regardless of `enabled` (see terminalSpawner.ts's platform guard).
  terminalSpawn: {
    enabled: boolean;
    // The executable to spawn (wt.exe by default). Never shell-interpreted — see `args` below.
    command: string;
    // Argv template — spawned with shell:false as a literal array, so there is no
    // quoting/escaping/injection surface. {cwd}/{name}/{title}/{launcher} placeholders are
    // substituted per element (see buildSpawnArgs in terminalSpawner.ts); {launcher} resolves to
    // <repoRoot>/bin/cc-attach.cmd.
    args: string[];
    // In-memory hourly cap on tabs opened, counted at spawn attempt (pruned trailing-hour window).
    maxPerHour: number;
    // How long the dispatcher polls for the newly spawned wrapper to both register itself over
    // /attach AND report {t:'ready'} (see src/attach/outputScanner.ts) before giving up and
    // leaving the tab for the human to paste the task into manually.
    waitForRegisterMs: number;
    // How long output must stay quiet, after claude's boot sequences are both seen, before the
    // wrapper reports readiness — read directly from config.json by src/attach/cli.ts (not via
    // loadConfig()), so it's threaded through here purely for type-shape documentation/defaults.
    readyQuietMs: number;
    // After injecting into a (just-spawned or already-attached) terminal, how long the dispatcher
    // polls (every 500ms) for the wrapper's own working-state signal (isWorking/isWorkingByName —
    // see src/attach/outputScanner.ts's "esc to interrupt" detection) to flip true, confirming the
    // paste actually landed and claude started processing it. NOT a ring/output-scrape check: a
    // pasted prompt never appears as contiguous bytes in ConPTY's diff-repainted output stream, so
    // screen-scraping for it produced false negatives (see CLAUDE.md's dispatch gotcha).
    confirmWorkingMs: number;
  };
  notifications: {
    enabled: boolean;
    permissionRequests: boolean;
    needsInput: boolean;
    turnEnd: boolean;
    limit: boolean;
    chatDelivery: boolean;
    aiIdleFilter: boolean;
    aiIdleFilterModel: string;
    outputTriggers: boolean;
  };
  push: {
    enabled: boolean;
    awayThresholdMinutes: number;
    apns: {
      keyPath: string;
      keyId: string;
      teamId: string;
      bundleId: string;
      environment: 'production' | 'sandbox';
    };
  };
  // Stale-session reaper (src/sessions/reaper.ts): force-killed/crashed terminals never fire a
  // SessionEnd hook, so their sessions stay 'idle' forever otherwise — causing stale LIVE badges
  // in the admin Sessions tab and false ambiguity in hub_register's tier-3 sole-active-named-
  // session resolution (see CLAUDE.md). An attached cc-attach wrapper is NEVER reaped regardless
  // of how long it's been quiet — only an unattached, truly-abandoned session is.
  sessions: {
    // How often the reaper tick runs.
    reapIntervalMs: number;
    // A non-ended session with no attached wrapper is reaped once its last_event_at is this many
    // minutes stale. Hours-scale on purpose — a human's long-lived idle terminal must never be
    // mistaken for an abandoned one.
    staleAfterMinutes: number;
    // Kill switch for session-name identity adoption (see CLAUDE.md's "Session names" subsection
    // and src/core/sessionNameIdentity.ts). When false, POST /hooks/session-name still stores the
    // name for display but never renames the instance.
    adoptSessionName: boolean;
  };
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

// --- DB row interfaces (snake_case columns, mirror src/db/migrations.ts) ---

export interface InstanceRow {
  id: number;
  name: string;
  cwd: string;
  alias: string | null;
  first_seen_at: number;
  last_seen_at: number;
  // Last URL the instance told the hub it's serving (via the hub_set_url MCP tool, or captured
  // automatically from cc-attach's `kind: 'url'` output-trigger notice) — see src/http/adminUi.ts's
  // renderInstanceUrls for where it's shown.
  app_url: string | null;
  app_url_at: number | null;
  // 0 = the single cwd-derived "default" identity for this directory (at most one per cwd — the
  // pre-existing one-identity-per-folder behavior); 1 = an explicitly-named sibling identity
  // (cc-attach --name / CC_HUB_NAME / hub_register name) — any number of these can share a cwd.
  // See src/core/identity.ts.
  named: number;
  name_source: InstanceNameSource;
}

export interface InstanceAppRow {
  id: number;
  instance_id: number;
  // Identity within the instance (UNIQUE(instance_id, label)) — e.g. "localhost:5173" for a web
  // app or a free-form name for a desktop app. url is null for a desktop app (no address to link).
  label: string;
  url: string | null;
  updated_at: number;
}

export interface InstanceAppJoined extends InstanceAppRow {
  instance_name: string;
}

export interface SessionRow {
  id: string;
  instance_id: number;
  cwd: string;
  transcript_path: string | null;
  status: SessionStatus;
  started_at: number;
  last_event_at: number;
  ended_at: number | null;
  last_prompt: string | null;
  mcp_session_id: string | null;
  resumed_from: string | null;
  auto_continue: number;
  continues_today: number;
  continues_date: string | null;
  interrupted_at: number | null;
  // What Claude Code's own `/name <x>` (or its auto-generated conversation title) currently shows
  // for this session — reported by the statusline via POST /hooks/session-name. See CLAUDE.md's
  // "Session names" subsection and src/core/sessionNameIdentity.ts.
  session_name: string | null;
}

export interface SessionJoined extends SessionRow {
  instance_name: string | null;
}

export interface MessageRow {
  id: number;
  from_name: string;
  to_name: string | null;
  body: string;
  urgent: number;
  created_at: number;
  summary: string | null;
}

export interface KbNoteRow {
  id: number;
  title: string;
  body: string;
  tags: string;
  author_name: string;
  created_at: number;
  updated_at: number;
}

export interface KbSearchResult {
  id: number;
  title: string;
  tags: string;
  snippet: string;
  // Relevance score; only the ordering is meaningful — bm25 (lower = better) on the FTS-only
  // path, reciprocal-rank-fusion (higher = better) on the hybrid FTS+vector path.
  rank: number;
}

export interface SessionEventRow {
  id: number;
  session_id: string;
  instance_name: string | null;
  type: string;
  payload: string | null;
  created_at: number;
}

export interface PendingPromptRow {
  id: number;
  session_id: string;
  prompt: string;
  source: PendingPromptSource;
  status: PendingPromptStatus;
  created_at: number;
  delivered_at: number | null;
  error: string | null;
}

export interface PermissionRow {
  id: number;
  session_id: string;
  tool_name: string;
  tool_input: string | null;
  raw: string | null;
  status: PermissionStatus;
  decided_by: string | null;
  decision_message: string | null;
  created_at: number;
  decided_at: number | null;
}

export interface LimitStateRow {
  id: number;
  state: LimitStateName;
  utilization: number | null;
  resets_at: number | null;
  last_poll_at: number | null;
  last_ok_poll_at: number | null;
  error: string | null;
}

export interface LimitEventRow {
  id: number;
  type: string;
  detail: string | null;
  created_at: number;
}

export interface PushTokenRow {
  token: string;
  platform: string;
  created_at: number;
  last_seen_at: number;
}

// --- Hook / runner payloads ---

export interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  [k: string]: unknown;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  startedAt: number;
  endedAt: number;
}

export interface Usage {
  pct: number;
  resetsAtMs: number | null;
  raw: unknown;
}

// --- Event bus ---

export type HubEvent =
  | { type: 'session_event'; sessionId: string; eventType: string; payload: unknown; createdAt: number }
  | { type: 'session_status'; sessionId: string; status: SessionStatus }
  | { type: 'message'; message: MessageRow }
  | { type: 'permission_request'; request: PermissionRow }
  | { type: 'permission_decided'; request: PermissionRow }
  | { type: 'limit_state'; state: LimitStateRow }
  | { type: 'chat_delivery'; instance: string; fromNames: string[]; count: number; createdAt: number }
  | { type: 'attach_output'; cwd: string; b64: string }
  | { type: 'attach_status'; cwd: string; attached: boolean }
  | { type: 'attach_notice'; cwd: string; kind: string; text: string };

// --- Service interfaces (seams between modules) ---

export interface IWsHub {
  broadcast(e: HubEvent): void;
}

export interface IClaudeRunner {
  resumePrompt(opts: { sessionId: string; cwd: string; prompt: string; permissionMode?: string }): Promise<RunResult>;
  startNew(opts: { cwd: string; prompt: string; permissionMode?: string }): Promise<RunResult>;
  isRunning(sessionId: string): boolean;
  runningCwd(cwd: string): boolean;
  atCapacity(): boolean;
}

export interface IPromptDelivery {
  // onSettled (if provided) is invoked once the actual spawned turn finishes — with `true` if it
  // completed successfully (exit code 0) and `false` if the spawn/turn failed. It is NOT invoked
  // for a 'queued' delivery (that prompt is durably queued and will run later regardless). It is
  // NOT invoked for an 'injected' delivery (no spawned turn to settle — the wrapper's own hooks
  // report status like any other human-typed turn). It is NOT invoked for a synchronous throw
  // from send() itself (callers already see that via rejection).
  send(
    sessionId: string,
    prompt: string,
    source: string,
    onSettled?: (ok: boolean) => void
  ): Promise<{ delivery: 'queued' | 'spawned' | 'injected'; pendingPromptId: number }>;
  claimForStopBlock(sessionId: string): { reason: string } | undefined;
}

// An attached `cc-attach` wrapper terminal, registered by project cwd (see src/attach/).
export interface AttachedClient {
  ws: WSContext;
  pid: number;
  lastSeen: number;
}

export interface IAttachRegistry {
  // `name`, when supplied, is the fully-resolved instance name (post collision disambiguation) —
  // clients are keyed internally by name so several named siblings can share one cwd. Omitted ->
  // a pure cwd-derived default key (see attachRegistry.ts's defaultNameForCwd).
  register(cwd: string, client: AttachedClient, name?: string): void;
  unregister(cwd: string, ws: WSContext): void;
  // Aggregate: the most-recently-registered client at this cwd (see src/attach/attachRegistry.ts
  // file header for the full cwd-vs-name aggregation contract).
  get(cwd: string): AttachedClient | undefined;
  // Direct name-keyed lookup, the name-precise counterpart to `get(cwd)` above — used by
  // src/spawn/dispatcher.ts to poll for a freshly spawned wrapper's registration. Optional so
  // pre-existing IAttachRegistry fakes in tests need no changes.
  getByName?(name: string): AttachedClient | undefined;
  // submit (default true) controls whether the wrapper follows the pasted prompt with an Enter
  // keypress — see src/attach/cli.ts's mode-aware submitKeys() (win32-input-mode vs raw CR).
  inject(cwd: string, prompt: string, submit?: boolean): boolean;
  // Direct name-keyed injection — prefer this over `inject(cwd, ...)` whenever the caller already
  // has the resolved instance name (session.instance_name / instance row), so a message for
  // "wb-sync" lands in wb-sync's terminal even if a different wrapper more recently registered
  // for the same cwd. Optional so pre-existing IAttachRegistry fakes in tests need no changes.
  injectByName?(name: string, prompt: string, submit?: boolean): boolean;
  touch(cwd: string, ws: WSContext): void;
  count(): number;
  // Pty output ring buffer (last 65536 bytes) per attached client — see
  // src/attach/attachRegistry.ts. cwd-keyed methods resolve to the most-recently-registered
  // client at that cwd.
  ingestOutput(cwd: string, b64: string): void;
  getRingB64(cwd: string): string | undefined;
  listAttached(): string[];
  // Live "is claude actively working" read reported by the wrapper's outputScanner (see
  // src/attach/outputScanner.ts) — truer than hub-side session status during subagent (Task)
  // work. Cleared on unregister/sweep-prune along with the rest of a client's attach state.
  // Unlike the other cwd-keyed methods, this is a genuine OR across every client at the cwd (see
  // attachRegistry.ts file header), not "most recent".
  setWorking(cwd: string, on: boolean): void;
  isWorking(cwd: string): boolean;
  // Direct name-keyed working-state lookup, the precise counterpart to isWorking(cwd)'s aggregate —
  // used by src/spawn/dispatcher.ts once it already knows the resolved name (a freshly spawned tab
  // always registers under a specific requested name; an inject-reuse target is already named).
  // Optional so pre-existing IAttachRegistry fakes in tests need no changes.
  isWorkingByName?(name: string): boolean;
  // TUI-ready flag reported by the wrapper's outputScanner (see src/attach/outputScanner.ts) once
  // claude's alt-screen + bracketed-paste boot sequence has been seen and output has gone quiet —
  // registration over /attach happens long before this and must never be treated as readiness (see
  // src/spawn/dispatcher.ts and CLAUDE.md's dispatch gotcha). Optional so pre-existing
  // IAttachRegistry fakes in tests need no changes.
  setReady?(cwd: string): void;
  // Direct name-keyed readiness lookup, the precise counterpart to isReady(cwd)'s aggregate — the
  // dispatcher prefers this once it knows the resolved name of a freshly spawned tab.
  isReadyByName?(name: string): boolean;
  // Read-side aggregate — genuine OR across every client at the cwd, matching isWorking(cwd).
  isReady?(cwd: string): boolean;
  // Admin-page rename (running instances, no restart): re-keys the live client entry (if any) from
  // oldName to newName. Optional so pre-existing IAttachRegistry fakes in tests need no changes.
  rename?(oldName: string, newName: string): void;
  stop(): void;
}

export interface ILimitWatcher {
  pokeNow(): void;
  stop(): void;
  forceState(state: LimitStateName, resetsAtMs?: number | null): void;
}

export interface IContinuationRunner {
  run(sessions: SessionRow[]): Promise<void>;
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

// Minimal structural seam onto McpGateway (src/mcp/server.ts) — lets a rename (admin ✎, session-
// name adoption) push into any live hub_register binding without pulling the MCP SDK import chain
// into modules that only need to rename, not build MCP tools (src/core/identity.ts,
// src/http/apiRoutes.ts, src/http/hooksRoutes.ts).
export interface RenameBindingSource {
  renameBinding(oldName: string, newName: string): void;
}
