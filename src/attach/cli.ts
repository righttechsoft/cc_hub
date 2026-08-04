// Wrapper entrypoint — `tsx src/attach/cli.ts [claude args]`, run by the user instead of
// `claude` directly. Spawns `claude` inside a hub-owned ConPTY, passes the user's terminal
// through transparently, loads the project .env into the child's environment, and holds a
// localhost WebSocket to the hub at /attach so the hub can inject remote prompts (mobile / chat)
// as if a human pasted them in. Standalone CLI — prints plainly to the terminal, does NOT go
// through the hub logger (src/log.ts is for the always-on hub process only).
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import WebSocket from 'ws'; // Node global WebSocket cannot set/inspect readyState the same way
import { bracketedPaste } from './injection.js';

// Light read of the hub's config.json (claudePath + port) — NOT loadConfig(), whose authToken/
// relay/push validation would wrongly abort a launcher. cc_hub root is two dirs up from src/attach.
function readHubConfig(): { claudePath?: string; port?: number } {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const c = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')) as Record<string, unknown>;
    return {
      claudePath: typeof c.claudePath === 'string' ? c.claudePath : undefined,
      port: typeof c.port === 'number' ? c.port : undefined,
    };
  } catch {
    return {};
  }
}

// node-pty does NOT PATH-resolve the executable the way child_process does — a bare name spawns
// with "File not found" on Windows. If the configured path already has a separator, use it; else
// scan PATH (Windows PATHEXT order prefers .EXE, so `claude` → the real claude.exe, not the .cmd
// shim node-pty can't run). Falls back to the bare name so spawn fails loudly rather than silently.
function resolveExecutable(cmd: string): string {
  if (cmd.includes('/') || cmd.includes('\\')) return cmd;
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = join(dir, cmd + ext);
      if (existsSync(full)) return full;
    }
  }
  return cmd;
}

const cwd = process.cwd();
const hubConfig = readHubConfig();
const claudePath = resolveExecutable(process.env.CC_HUB_CLAUDE || hubConfig.claudePath || 'claude');
const hubUrl = process.env.CC_HUB_URL || `http://127.0.0.1:${hubConfig.port ?? 4270}`;
const heartbeatMs = Number(process.env.CC_HUB_ATTACH_HEARTBEAT_MS) || 30000;

const MIN_OPEN_MS_FOR_RESET = 30_000;
const MAX_BACKOFF_MS = 60_000;

let fileEnv: Record<string, string | undefined> = {};
try {
  fileEnv = parseEnv(readFileSync(join(cwd, '.env'), 'utf8'));
} catch {
  // no .env in this dir — fine
}
const childEnv = { ...process.env, ...fileEnv, CC_HUB_ATTACHED: '1' };

// Minimal node-pty surface used here — kept local instead of depending on node-pty's own types
// so `tsc --noEmit` passes even when node-pty (an optionalDependency, loaded only via dynamic
// import below) isn't installed.
interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
}
interface PtyModule {
  spawn(
    file: string,
    args: string[],
    opts: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: NodeJS.ProcessEnv;
      useConpty?: boolean;
      conptyInheritCursor?: boolean;
    }
  ): PtyProcess;
}

async function main(): Promise<void> {
  let ptyModule: PtyModule;
  try {
    // Dynamic import: mirrors src/kb/embedder.ts — a static import would fail the whole wrapper
    // (and would drag node-pty into anything that ever imports this module) if the native
    // binding isn't built for this platform. The module name is passed through a variable
    // (not a string literal) so tsc treats the import as `Promise<any>` instead of trying to
    // resolve node-pty's types — it's an optionalDependency and may not be installed.
    // Prebuilt multiarch fork of node-pty (drop-in `.spawn` API) — ships Windows/Node prebuilds so
    // no MSVC/winpty compile is needed (stock node-pty 1.0.0 fails to build from the npm tarball on
    // Windows). Passed as a variable, not a literal, so tsc treats the import as `Promise<any>`
    // instead of resolving the optional dependency's types when it isn't installed.
    const moduleName = '@homebridge/node-pty-prebuilt-multiarch';
    ptyModule = (await import(moduleName)) as unknown as PtyModule;
  } catch {
    process.stderr.write('node-pty unavailable — run `claude` directly; hub falls back to headless delivery\n');
    process.exit(1);
  }

  // Windows default = winpty. node-pty's ConPTY maintains a virtual screen and emits re-rendered
  // diffs; relayed through to the outer Windows Terminal (double-hosting) it desyncs the cursor
  // right after the first keystroke (typed line renders with a stray gap / in the wrong spot).
  // winpty pipes the child's bytes literally — no screen-diffing — which fixes it (confirmed).
  // CC_HUB_USE_CONPTY=1 forces ConPTY back for anyone who prefers its rendering; conptyInheritCursor
  // only matters on that path (keeps the pseudoconsole's initial cursor aligned).
  const useConpty = process.platform === 'win32' ? process.env.CC_HUB_USE_CONPTY === '1' : true;
  const pty = ptyModule.spawn(claudePath, process.argv.slice(2), {
    name: 'xterm-256color',
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    cwd,
    env: childEnv,
    useConpty,
    conptyInheritCursor: true,
  });

  function restoreTerminal(): void {
    try {
      process.stdin.setRawMode?.(false);
    } catch {
      // ignore — stdin may not be a TTY
    }
    process.stdin.pause();
  }

  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.on('data', (d) => pty.write(d.toString('binary')));

  // Only resize the pty when the terminal's dimensions actually change. Windows Terminal fires
  // 'resize' on interactions that don't change size (focus, redraw); each pty.resize() makes
  // ConPTY reflow and repaint the whole screen, which can race the echo of a key you just typed
  // and garble the line (stray first character).
  let lastCols = process.stdout.columns || 80;
  let lastRows = process.stdout.rows || 24;
  process.stdout.on('resize', () => {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    if (cols === lastCols && rows === lastRows) return;
    lastCols = cols;
    lastRows = rows;
    pty.resize(cols, rows);
  });

  const attach = connectAttach(pty);
  // pty.onData is the local terminal's only output source — write it straight through, then feed
  // the hub's mirror on a LATER tick. Doing the coalescer/WS work inline would add latency between
  // the child's output chunks and the real terminal, making ConPTY's output burstier and racing
  // the echo of freshly-typed input (garbled first keystroke). setImmediate preserves order.
  pty.onData((d) => {
    process.stdout.write(d);
    setImmediate(() => attach.feedOutput(d));
  });

  pty.onExit(({ exitCode }) => {
    restoreTerminal();
    attach.stop();
    process.exit(exitCode ?? 0);
  });

  process.on('exit', () => {
    try {
      pty.kill();
    } catch {
      // ignore — pty may already be gone
    }
  });
  // No SIGINT handler on purpose — Ctrl-C must pass through raw stdin to the pty like any other
  // keystroke, not kill the wrapper.
  process.on('SIGTERM', () => {
    try {
      pty.kill();
    } catch {
      // ignore
    }
    process.exit(0);
  });
}

// Localhost WS client to the hub's /attach endpoint. Registers the cwd so the hub can route
// mobile prompts / chat messages here instead of spawning a headless turn. Never allowed to
// crash the wrapper: a hub that's down or unreachable just means no injection, terminal still
// works normally.
function connectAttach(pty: PtyProcess): { stop(): void; feedOutput(data: string): void } {
  const wsUrl = hubUrl.replace(/^http/, 'ws') + '/attach';

  // Coalescing rule (pinned protocol): flush when buffered >= 8192 bytes OR 16ms after the first
  // un-flushed byte, whichever comes first. Keeps the hub's ring warm even with no subscriber —
  // this is always-on once registered, not gated on a subscriber existing.
  const OUTPUT_FLUSH_BYTES = 8192;
  const OUTPUT_FLUSH_MS = 16;

  let ws: WebSocket | null = null;
  let attempt = 0;
  let openedAt = 0;
  let stopped = false;
  let closedHandled = false;
  let warnedThisOutage = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let outBuf: Buffer[] = [];
  let outBufLen = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function clearHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function clearFlushTimer(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  // Flushes buffered pty output as one {t:'output'} frame. Never throws into the pty callback —
  // a send failure just means this chunk is lost; the next flush and the hub's ring resync it.
  function flushOutput(): void {
    clearFlushTimer();
    if (outBufLen === 0) return;
    const buf = Buffer.concat(outBuf, outBufLen);
    outBuf = [];
    outBufLen = 0;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ t: 'output', b64: buf.toString('base64') }));
      } catch {
        // ignore — next flush or reconnect resyncs via the hub's ring
      }
    }
  }

  // Called from the pty.onData callback — must never throw or block.
  function feedOutput(data: string): void {
    try {
      const chunk = Buffer.from(data, 'binary');
      outBuf.push(chunk);
      outBufLen += chunk.length;
      if (outBufLen >= OUTPUT_FLUSH_BYTES) {
        flushOutput();
        return;
      }
      if (!flushTimer) flushTimer = setTimeout(flushOutput, OUTPUT_FLUSH_MS);
    } catch {
      // ignore — output streaming must never crash the wrapper
    }
  }

  function startHeartbeat(socket: WebSocket): void {
    clearHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        try {
          socket.send('{"type":"ping"}');
        } catch {
          // ignore — next heartbeat or the close/error handler will deal with it
        }
      }
    }, heartbeatMs);
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    const delay = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
    attempt++;
    reconnectTimer = setTimeout(() => {
      if (!stopped) connect();
    }, delay);
  }

  function handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const msg = parsed as Record<string, unknown>;
    if (msg.t === 'inject' && typeof msg.prompt === 'string') {
      try {
        pty.write(bracketedPaste(msg.prompt));
      } catch {
        // ignore — pty may already be gone
      }
      return;
    }
    // {type:'pong'} needs no handling — heartbeat is fire-and-forget.
  }

  function connect(): void {
    if (stopped) return;
    closedHandled = false;
    const socket = new WebSocket(wsUrl);
    ws = socket;

    socket.on('open', () => {
      openedAt = Date.now();
      warnedThisOutage = false;
      try {
        socket.send(JSON.stringify({ t: 'register', cwd, pid: process.pid }));
      } catch {
        // ignore — next heartbeat tick or a close/error will trigger reconnect
      }
      startHeartbeat(socket);
    });

    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      handleMessage(data.toString());
    });

    const onDown = (): void => {
      if (closedHandled) return;
      closedHandled = true;
      clearHeartbeat();
      if (!warnedThisOutage) {
        warnedThisOutage = true;
        process.stderr.write('cc-attach: hub connection unavailable — remote prompts will not be injected until it reconnects\n');
      }
      if (openedAt !== 0 && Date.now() - openedAt >= MIN_OPEN_MS_FOR_RESET) attempt = 0;
      openedAt = 0;
      if (!stopped) scheduleReconnect();
    };
    socket.on('close', onDown);
    socket.on('error', onDown);
  }

  connect();

  return {
    stop(): void {
      stopped = true;
      clearHeartbeat();
      clearFlushTimer();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try {
        ws?.close();
      } catch {
        // ignore
      }
    },
    feedOutput,
  };
}

main();
