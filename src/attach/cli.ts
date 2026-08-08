// Wrapper entrypoint — `tsx src/attach/cli.ts [claude args]`, run by the user instead of
// `claude` directly. Spawns `claude` inside a hub-owned ConPTY, passes the user's terminal
// through transparently, loads the project .env into the child's environment, and holds a
// localhost WebSocket to the hub at /attach so the hub can inject remote prompts (mobile / chat)
// as if a human pasted them in. Standalone CLI — prints plainly to the terminal, does NOT go
// through the hub logger (src/log.ts is for the always-on hub process only).
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import WebSocket from 'ws'; // Node global WebSocket cannot set/inspect readyState the same way
import { readClipboardForPaste } from './clipboard.js';
import { bracketedPaste } from './injection.js';
import { createOutputScanner, type NoticeKind } from './outputScanner.js';
import { applyPasteHygiene } from './pasteHygiene.js';
import { decodeSnippetEvents, INITIAL_SNIPPET_STATE, sanitizeSnippetsConfig, stepSnippet, type SnippetState } from './snippets.js';

// Diagnostic trace for the smart-paste path — appended to %TEMP%/cc-attach-debug.log. Always logs
// the paste trigger + clipboard outcome (low volume); CC_HUB_PASTE_DEBUG=1 additionally logs every
// raw stdin chunk as hex, to see exactly what the terminal sends on Ctrl+V. Best-effort, never throws.
const DEBUG_LOG = join(tmpdir(), 'cc-attach-debug.log');
const pasteDebug = process.env.CC_HUB_PASTE_DEBUG === '1';
function dlog(msg: string): void {
  try {
    appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // ignore — diagnostics must never break the wrapper
  }
}

// Best-effort cleanup of smart-paste temp images (clipboard.ts writes ccpaste_<guid>.png into
// %TEMP%). claude reads an attached image within seconds of the paste, so anything older than a
// day is safe to delete. Never throws — a failed sweep must not affect startup.
const PASTE_TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
function sweepOldPasteImages(): void {
  try {
    const dir = tmpdir();
    const now = Date.now();
    for (const name of readdirSync(dir)) {
      if (!/^ccpaste_[0-9a-f]+\.png$/i.test(name)) continue;
      const full = join(dir, name);
      try {
        if (now - statSync(full).mtimeMs > PASTE_TMP_MAX_AGE_MS) unlinkSync(full);
      } catch {
        // ignore a single un-stattable/locked file
      }
    }
  } catch {
    // ignore — cleanup is best-effort
  }
}
sweepOldPasteImages();

// Light read of the hub's config.json (claudePath + port + attach.redactSecrets/fenceCodePastes/
// snippets) — NOT loadConfig(), whose authToken/relay/push validation would wrongly abort a
// launcher. cc_hub root is two dirs up from src/attach.
function readHubConfig(): {
  claudePath?: string;
  port?: number;
  redactSecrets: boolean;
  fenceCodePastes: boolean;
  snippets: Record<string, string>;
} {
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const c = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')) as Record<string, unknown>;
    const attach = (c.attach && typeof c.attach === 'object' ? c.attach : {}) as Record<string, unknown>;
    return {
      claudePath: typeof c.claudePath === 'string' ? c.claudePath : undefined,
      port: typeof c.port === 'number' ? c.port : undefined,
      redactSecrets: typeof attach.redactSecrets === 'boolean' ? attach.redactSecrets : true,
      fenceCodePastes: typeof attach.fenceCodePastes === 'boolean' ? attach.fenceCodePastes : false,
      snippets: sanitizeSnippetsConfig(attach.snippets),
    };
  } catch {
    return { redactSecrets: true, fenceCodePastes: false, snippets: {} };
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
const redactSecrets = hubConfig.redactSecrets;
const fenceCodePastes = hubConfig.fenceCodePastes;

const MIN_OPEN_MS_FOR_RESET = 30_000;
const MAX_BACKOFF_MS = 60_000;
// Hub's "displaced by a newer wrapper for this cwd" close code (attachRegistry CLOSE_DISPLACED)
// and the dormant retry cadence a displaced wrapper drops to (see scheduleReconnect).
const CLOSE_DISPLACED_CODE = 4001;
const DISPLACED_RETRY_MS = 300_000;

// Snippets / prompt macros: leader key (Ctrl+G) + one selector character expands to a
// config-defined canned text (src/attach/snippets.ts has the pure leader/selector state machine).
// Gated entirely on `snippets` being non-empty — with the default empty config.json map, `snippet`
// is never referenced in the stdin handler below and Ctrl+G passes through completely untouched.
const snippets = hubConfig.snippets;
const snippetsEnabled = Object.keys(snippets).length > 0;
const SNIPPET_LEADER_TIMEOUT_MS = 3000;
let snippetState: SnippetState = INITIAL_SNIPPET_STATE;
let snippetTimer: ReturnType<typeof setTimeout> | null = null;

function clearSnippetTimeout(): void {
  if (snippetTimer) {
    clearTimeout(snippetTimer);
    snippetTimer = null;
  }
}

// A leader press with no selector following within 3s auto-cancels back to normal typing.
function armSnippetTimeout(): void {
  clearSnippetTimeout();
  snippetTimer = setTimeout(() => {
    snippetTimer = null;
    snippetState = INITIAL_SNIPPET_STATE;
  }, SNIPPET_LEADER_TIMEOUT_MS);
}

// win32-input-mode tracking: conpty.dll turns this mode on (ESC[?9001h) so claude reads keyboard
// input as key-event records instead of raw bytes — a lone '\r' is then NOT interpreted as Enter
// (see the Ctrl+V decoding note above for the same mode's effect on paste). Updated from the pty's
// own OUTPUT (the DEC private mode escape), so the injected-prompt submit key below always matches
// whatever mode claude actually turned on, regardless of pty backend.
let win32InputMode = false;
function scanWin32InputMode(chunk: string): void {
  const enable = chunk.lastIndexOf('\x1b[?9001h');
  const disable = chunk.lastIndexOf('\x1b[?9001l');
  if (enable === -1 && disable === -1) return;
  win32InputMode = enable > disable;
}

// The key sequence that submits an injected prompt, matching whichever input mode claude is
// currently in. win32-input-mode wants a full key-event record (keydown + keyup) for Enter
// (Vk=13 VK_RETURN, Sc=28, Uc=13 '\r') — this mirrors what Windows Terminal itself sends for
// Enter in that mode. Otherwise a raw CR (bracketed-paste submit) is what claude expects.
function submitKeys(): string {
  return win32InputMode ? '\x1b[13;28;13;1;0;1_\x1b[13;28;13;0;0;1_' : '\r';
}

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
      useConptyDll?: boolean;
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

  // Windows backend choice:
  //   - ConPTY (default) preserves the outer terminal's SCROLLBACK; winpty repaints a fixed
  //     viewport and LOSES it (you can only scroll ~one page up).
  //   - In-box ConPTY has an intermittent first-keystroke desync (a typed line renders with a
  //     stray gap). The modern standalone **conpty.dll** (`useConptyDll`) fixes ConPTY's rendering
  //     bugs while keeping scrollback — so it's the default, giving us both. conptyInheritCursor
  //     aligns the initial cursor as a further guard.
  //   - Escape hatches: CC_HUB_USE_WINPTY=1 (winpty, no scrollback, for stubborn input bugs);
  //     CC_HUB_NO_CONPTY_DLL=1 (plain in-box ConPTY, if the dll misbehaves).
  const useConpty = process.platform === 'win32' ? process.env.CC_HUB_USE_WINPTY !== '1' : true;
  const wantConptyDll = useConpty && process.platform === 'win32' && process.env.CC_HUB_NO_CONPTY_DLL !== '1';

  const spawnPty = (withDll: boolean): PtyProcess =>
    ptyModule.spawn(claudePath, process.argv.slice(2), {
      name: 'xterm-256color',
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
      cwd,
      env: childEnv,
      useConpty,
      conptyInheritCursor: true,
      ...(withDll ? { useConptyDll: true } : {}),
    });

  let usedDll = wantConptyDll;
  let pty: PtyProcess;
  try {
    pty = spawnPty(wantConptyDll);
  } catch (err) {
    if (!wantConptyDll) throw err;
    // conpty.dll not available in this build — fall back to in-box ConPTY rather than dying.
    usedDll = false;
    pty = spawnPty(false);
  }

  const backend = process.platform !== 'win32' ? 'conpty' : !useConpty ? 'winpty' : usedDll ? 'conpty+dll' : 'conpty';
  process.stderr.write(`cc-attach: pty backend = ${backend}\n`);

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
  // Smart paste: the user rebinds Windows Terminal's Ctrl+V to send byte 0x16 (SYN) instead of
  // its own paste, since WT's native paste bypasses the pty entirely and can't be intercepted
  // here. On 0x16 we read the OS clipboard ourselves and inject it as a non-submitting bracketed
  // paste (image → temp PNG path, Explorer file copy → its path, text → the text itself) so the
  // user can review before pressing Enter. 0x16 itself is swallowed, never forwarded to the pty.
  // Fully fail-soft: non-Windows, PowerShell missing, empty/unreadable clipboard, or any error
  // all just no-op — normal typing and the pty are never blocked or crashed by this.
  // Ctrl+V arrives in one of two encodings depending on the pty backend, and we must strip it out
  // (so claude never sees it) and trigger smart paste instead:
  //   - raw byte 0x16 (SYN) — in-box ConPTY / winpty, or a WT sendInput rebind.
  //   - a win32-input-mode key record ESC[Vk;Sc;Uc;Kd;Cs;Rc_ — conpty.dll turns win32-input-mode
  //     on (ESC[?9001h), so keys come through encoded. Ctrl+V's unicode value is 22, so we match
  //     Uc=22, fire on the keydown (Kd=1), and drop both the down and up records.
  const WIN32_CTRL_V = /\x1b\[\d+;\d+;22;([01]);\d+;\d+_/g;
  process.stdin.on('data', (d) => {
    if (pasteDebug) dlog(`stdin chunk (${d.length}B): ${d.toString('hex')}`);
    let s = d.toString('binary');
    let paste = false;

    s = s.replace(WIN32_CTRL_V, (_m, kd: string) => {
      if (kd === '1') paste = true;
      return '';
    });
    if (s.indexOf('\x16') !== -1) {
      paste = true;
      s = s.split('\x16').join('');
    }

    if (snippetsEnabled) s = processSnippetChunk(s);

    if (s.length > 0) pty.write(s);
    if (paste) {
      dlog('smart-paste: Ctrl+V detected');
      handleSmartPaste();
    }
  });

  // Leader-key (Ctrl+G) snippet expansion — runs over whatever's left after Ctrl+V has already
  // been stripped out above (0x16 and 0x07 are distinct bytes/Uc values, so the two interceptors
  // never see each other's markers). Only called when `snippetsEnabled`, so this whole path is
  // dead code with the default empty snippets config. Guarded so a bug here can never swallow or
  // corrupt normal typing — on any error, the chunk is forwarded exactly as received.
  function processSnippetChunk(s: string): string {
    try {
      let forward = '';
      for (const event of decodeSnippetEvents(s)) {
        const step = stepSnippet(snippetState, event, snippets);
        forward += step.forward;
        if (step.inject !== undefined) pty.write(bracketedPaste(step.inject, { submit: false }));
        if (step.state.awaitingKey !== snippetState.awaitingKey) {
          if (step.state.awaitingKey) armSnippetTimeout();
          else clearSnippetTimeout();
        }
        snippetState = step.state;
      }
      return forward;
    } catch {
      return s;
    }
  }

  function handleSmartPaste(): void {
    readClipboardForPaste()
      .then((clip) => {
        if (!clip) {
          dlog('smart-paste: clipboard returned null (empty/unreadable)');
          return;
        }
        // Log the kind always, but the value only under CC_HUB_PASTE_DEBUG — pasted text can
        // contain secrets and must not land in a plaintext temp log by default.
        dlog(pasteDebug ? `smart-paste: injecting ${clip.kind} — ${clip.value.slice(0, 120)}` : `smart-paste: injecting ${clip.kind}`);
        const out = applyPasteHygiene(clip.value, { redact: redactSecrets, fence: fenceCodePastes });
        pty.write(bracketedPaste(out, { submit: false }));
      })
      .catch((err: unknown) => {
        dlog(`smart-paste: clipboard read threw — ${err instanceof Error ? err.message : String(err)}`);
      });
  }

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
  // Watches the same output for claude's "esc to interrupt" running indicator and reports
  // debounced working/idle transitions to the hub, so it can suppress false "needs input"
  // notifications during subagent (Task) work — see src/attach/outputScanner.ts.
  const scanner = createOutputScanner((on) => attach.sendWorking(on), {
    onNotice: (kind, text) => attach.sendNotice(kind, text),
  });
  // pty.onData is the local terminal's only output source — write it straight through, then feed
  // the hub's mirror on a LATER tick. Doing the coalescer/WS work inline would add latency between
  // the child's output chunks and the real terminal, making ConPTY's output burstier and racing
  // the echo of freshly-typed input (garbled first keystroke). setImmediate preserves order.
  pty.onData((d) => {
    process.stdout.write(d);
    scanWin32InputMode(d);
    setImmediate(() => {
      scanner.feed(d);
      attach.feedOutput(d);
    });
  });

  pty.onExit(({ exitCode }) => {
    restoreTerminal();
    scanner.stop();
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
function connectAttach(
  pty: PtyProcess
): { stop(): void; feedOutput(data: string): void; sendWorking(on: boolean): void; sendNotice(kind: NoticeKind, text: string): void } {
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
  let displaced = false;
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
    // Displaced by another cc-attach in the same directory (hub close code 4001): go dormant
    // with a slow fixed retry instead of the normal ladder — an eager reconnect would displace
    // the newer wrapper right back, and the two would ping-pong the slot forever. The slow retry
    // still self-heals if the winner exits later.
    const delay = displaced ? DISPLACED_RETRY_MS : Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);
    if (!displaced) attempt++;
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
      const submit = msg.submit !== false;
      try {
        // Paste the body without bracketedPaste's own trailing '\r' — under win32-input-mode
        // that raw CR isn't read as Enter (see win32InputMode above), so submission is a
        // separate, mode-aware key write.
        pty.write(bracketedPaste(msg.prompt, { submit: false }));
        dlog(
          `inject: len=${msg.prompt.length} submit=${String(submit)} win32=${String(win32InputMode)}`
        );
        if (submit) {
          // Short single-line prompts (mobile) submit with an IMMEDIATE Enter — this is the
          // proven-working path; delaying it regressed mobile submit. Only large/multi-line
          // pastes (chat deliveries) get a delayed Enter, so claude finishes ingesting the
          // paste before Enter lands instead of swallowing it into the paste.
          const needsDelay = msg.prompt.length > 1000 || msg.prompt.includes('\n');
          const fire = (): void => {
            try {
              const keys = submitKeys();
              dlog(`inject: submit fire win32=${String(win32InputMode)} keys=${Buffer.from(keys, 'binary').toString('hex')}`);
              pty.write(keys);
            } catch {
              // ignore — pty may already be gone
            }
          };
          if (needsDelay) setTimeout(fire, 150);
          else fire();
        }
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
      displaced = false;
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

    // NEVER write runtime notices to stderr here: it is the same screen claude's TUI is drawing
    // on, so any post-startup print corrupts the interactive display (fragments bleed into the
    // conversation). All connection chatter goes to the debug log file instead.
    const onDown = (code?: number): void => {
      if (closedHandled) return;
      closedHandled = true;
      clearHeartbeat();
      if (code === CLOSE_DISPLACED_CODE) {
        displaced = true;
        dlog('attach ws: displaced by another cc-attach in this cwd — dormant, slow retry');
      } else if (!warnedThisOutage) {
        warnedThisOutage = true;
        dlog('attach ws: hub connection unavailable — remote prompts not injected until reconnect');
      }
      if (openedAt !== 0 && Date.now() - openedAt >= MIN_OPEN_MS_FOR_RESET) attempt = 0;
      openedAt = 0;
      if (!stopped) scheduleReconnect();
    };
    socket.on('close', (code) => onDown(code));
    socket.on('error', () => onDown());
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
    // Best-effort — if the socket is down, just skip; the hub falls back to status-based
    // suppression until the wrapper reconnects and the scanner's next transition resyncs it.
    sendWorking(on: boolean): void {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ t: 'working', on }));
      } catch {
        // ignore — next reconnect resyncs
      }
    },
    // Best-effort — if the socket is down, the notice is simply dropped (outputScanner's own
    // dedup/rate-limit means a missed one isn't a big loss; it'll fire again on the next sighting).
    sendNotice(kind: NoticeKind, text: string): void {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ t: 'notice', kind, text }));
      } catch {
        // ignore
      }
    },
  };
}

main();
