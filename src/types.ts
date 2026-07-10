// Shared contract types for cc_hub. Every module imports from here — keep in sync with
// src/db/migrations.ts (schema) and the plan's DB / bus sections.

export type SessionStatus = 'active' | 'idle' | 'ended' | 'interrupted' | 'continuing';

export type LimitStateName = 'ok' | 'limited' | 'waiting_reset' | 'continuing' | 'unknown';

export type PendingPromptSource = 'mobile' | 'limit_watcher' | 'api' | 'chat';

export type PendingPromptStatus = 'queued' | 'delivering' | 'delivered' | 'failed' | 'cancelled';

export type PermissionStatus = 'pending' | 'allowed' | 'denied' | 'timeout';

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
  athen: {
    // Kill switch for local embeddings (onnxruntime/sqlite-vec load failure, offline machine).
    // Off = athen_search degrades to FTS-only; notes are never lost either way.
    embeddings: boolean;
    // Changing the model drops and rebuilds the vector table (old vectors are garbage for a
    // new model); notes re-embed via the startup backfill.
    model: string;
  };
  notifications: {
    enabled: boolean;
    permissionRequests: boolean;
    needsInput: boolean;
    turnEnd: boolean;
    limit: boolean;
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
  | { type: 'limit_state'; state: LimitStateRow };

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
  // NOT invoked for a synchronous throw from send() itself (callers already see that via rejection).
  send(
    sessionId: string,
    prompt: string,
    source: string,
    onSettled?: (ok: boolean) => void
  ): Promise<{ delivery: 'queued' | 'spawned'; pendingPromptId: number }>;
  claimForStopBlock(sessionId: string): { reason: string } | undefined;
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
