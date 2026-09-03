// Detects whether claude is actively WORKING (turn/tool/subagent in progress) purely from the
// pty output bytes the wrapper already sees. The hub-side session status is unreliable during
// subagent (Task) work, so this gives desktopNotifier/pushNotifier a truth signal straight from
// the terminal: claude shows a live "esc to interrupt" running indicator while a turn, tool, or
// subagent is running, and clears it once it's back at the prompt. We don't parse the screen —
// just watch for that substring appearing/disappearing in the byte stream.
const ANSI_ESCAPE_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][A-Za-z0-9]|\x1b[=>]/g;

// Running-indicator patterns — these track Claude Code's TUI wording/layout and WILL break again
// across CC releases; re-verify whenever CC's UI changes. ANY match against the ANSI-stripped
// rolling tail counts as "working". How to re-derive this list when it goes stale: attach a `/ws`
// client, send `{"type":"attach_subscribe","cwd":"<target cwd>"}` while that instance is actively
// mid-turn, ANSI-strip the returned/incremental `attach_output` frames (`stripAnsi` below), and
// diff against the idle-state output to find what text is unique to the working state.
//
// - Pattern 1 (`esc to interrupt`) is the legacy marker — kept for older CC versions that still
//   print it.
// - Patterns 2-4 were derived from a live capture of CC v2.1.251, which prints NO "esc to
//   interrupt" text at all (a 64KB idle-vs-working diff contained not even the word "interrupt").
//   Instead its running status line looks like `(30s · thinking with xhigh effort · ↑ 5.5k
//   tokens)` — patterns 2-4 each match one fragment of that line independently (order/spacing
//   between fragments isn't assumed) and are deliberately shaped like the status line's own
//   punctuation (a `(<number>s ·` opener, a `<number>k? tokens)` closer, parenthesized) rather than
//   bare words, so ordinary conversation text mentioning "tokens" or elapsed seconds doesn't false-
//   positive.
export const RUN_MARKER_PATTERNS: RegExp[] = [
  /esc to interrupt/i,
  /\(\d+s\s*·/,
  /[\d.]+k?\s*tokens\)/i,
  /thinking with \w+ effort/i,
];

// How much recent (ANSI-included) output to keep for matching. Live testing against a genuinely
// mid-turn session found the markers above DO match its output ring — but a 4KB tail missed them:
// claude's status line is diff-repainted (ConPTY emits only the changed cells, not a full
// re-print), so it can go well beyond 4KB of unrelated output between repaints. A sighting
// anywhere in recent output is what matters, not proximity to the tail end, so the window is
// widened to 32KB. This is only affordable because feed() below early-returns while `working` is
// already true (any output sustains it — see the comment on that branch), so this regex scan only
// ever runs in the idle state, where output is comparatively sparse; do NOT hoist the scan above
// that early-return, or it would run per-chunk during the high-volume working state too. The tail
// is wiped on the idle transition (see goIdle), so a stale marker can't re-trigger a false ON.
const TAIL_MAX_BYTES = 32768;

// How long to wait after the last marker sighting before declaring claude idle. claude redraws
// the running indicator frequently while active, so any real gap this long means the turn ended.
const DEFAULT_IDLE_AFTER_MS = 1500;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_ESCAPE_RE, '');
}

export function containsRunMarker(s: string): boolean {
  const stripped = stripAnsi(s);
  return RUN_MARKER_PATTERNS.some((re) => re.test(stripped));
}

// --- Output notice triggers (build/test failures, local dev-server URLs) -----------------------
// Independent of the working-marker tail/idle machinery above: scans visual segments of pty
// output — ended by a newline, CR, or any vertical cursor move (CUP/CUU/CUD/CNL/CPL/VPA), since
// fullscreen-TUI output contains no newlines at all — for a small, tightly-anchored set of markers
// and reports them via onNotice so cc-attach can push a hub notification. Deliberately
// conservative — this drives OS toasts, so false positives are worse than misses: only complete
// segments are scanned (a marker split across two feed() calls is buffered until its terminator
// arrives) and repeats are de-duplicated/rate-limited.

export type NoticeKind = 'build_failed' | 'url';

const BUILD_FAILED_PATTERNS: RegExp[] = [
  /npm error/,
  /npm ERR!/,
  /BUILD FAILED/,
  /error TS\d{3,}/,
  /Traceback \(most recent call last\):/,
  /error\[E\d/,
  /FAILED \(/,
  /Tests:\s+\d+ failed/,
  /\bFAIL\b .+\.(test|spec)\./,
  /panic:/,
  /pytest.*failed/i,
];

// Local dev-server URLs only — arbitrary internet URLs are far too common in normal output to
// treat as notable.
const LOCAL_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?(?:\/\S*)?/;

// Fullscreen-TUI output contains NO newlines — ConPTY paints rows with cursor positioning (a
// real 64KB capture had zero \n bytes). A visual "line" therefore ends at a newline, a CR, or
// any vertical cursor movement: CUP/HVP (H/f), CUU/CUD (A/B), CNL/CPL (E/F), VPA (d). Horizontal
// moves (C/D/G) and SGR stay inside the segment; stripAnsi in detectNotice removes them.
const SEGMENT_END_RE = /\r\n|[\r\n]|\x1b\[[0-9;]*[ABEFHfd]/;

const NOTICE_TEXT_MAX_CHARS = 200;
// A repeat of the same kind+text within this window is suppressed. In a scrollback world a line
// prints once, but a fullscreen TUI repaints the same visible text over and over for as long as
// it stays on screen — a short window would re-toast a still-visible URL/failure every repaint;
// 10 minutes makes a sighting effectively once-per-episode while still letting a genuinely
// re-announced server re-fire later.
const NOTICE_DEDUP_WINDOW_MS = 600_000;
// Overall cap regardless of kind/text — protects against a burst of *different* matches.
const NOTICE_MIN_INTERVAL_MS = 1000;
// Trailing partial-line buffer cap — a pathological line with no newline for a long time must not
// grow unbounded.
const LINE_BUF_MAX_CHARS = 4096;

function detectNotice(line: string): { kind: NoticeKind; text: string } | null {
  const stripped = stripAnsi(line);
  if (BUILD_FAILED_PATTERNS.some((re) => re.test(stripped))) {
    return { kind: 'build_failed', text: stripped.trim().slice(0, NOTICE_TEXT_MAX_CHARS) };
  }
  const urlMatch = stripped.match(LOCAL_URL_RE);
  if (urlMatch) {
    // TUI segments put URLs inside prose/commands ("http://localhost:47311/healthz; echo"), so
    // the \S* path match can drag trailing punctuation in — strip it before normalizing.
    const text = urlMatch[0].replace(/[.,;:!?)\]'"»]+$/, '').replace('0.0.0.0', 'localhost');
    return { kind: 'url', text };
  }
  return null;
}

// --- TUI readiness detection ---------------------------------------------------------------
// One-shot detector for "claude's TUI has finished booting and can safely accept an injected
// paste". Registration over /attach happens ~1.5s into boot — long before the TUI is ready — so
// treating it as readiness caused dispatched tasks to land mid-boot-repaint and vanish (see
// CLAUDE.md's dispatch gotcha). A live capture showed the real order: claude turns on
// bracketed-paste mode (ESC[?2004h) EARLY during boot, and only afterwards enters the terminal's
// alternate screen buffer (ESC[?1049h) and paints the TUI (ESC[2J). Waiting for BOTH sequences
// (order-independent — don't assume which comes first) plus a short quiet period after the last
// one gives the boot paint time to settle before anything is typed into the pty.
const ALT_SCREEN_ON_SEQ = '\x1b[?1049h';
const BRACKETED_PASTE_ON_SEQ = '\x1b[?2004h';

// Rolling tail used to detect the two sequences above. Deliberately NOT ANSI-stripped — these
// sequences ARE what stripAnsi would remove — but still a rolling window (like the working-marker
// tail) so a sequence split across two pty chunks is still caught.
const READY_TAIL_MAX_BYTES = 64;

const DEFAULT_READY_QUIET_MS = 1200;

export interface OutputScannerOptions {
  idleAfterMs?: number;
  onNotice?: (kind: NoticeKind, text: string) => void;
  // How long output must be quiet after both readiness sequences are seen before onReady fires —
  // lets the boot paint that follows the alt-screen takeover settle first.
  readyQuietMs?: number;
  onReady?: () => void;
}

export interface OutputScanner {
  feed(chunk: string): void;
  stop(): void;
  isWorking(): boolean;
  isReady(): boolean;
}

// createOutputScanner(onWorkingChange): feed() is called from the pty's onData handler with each
// raw chunk. Turning ON still requires a marker sighting in the rolling tail. Once ON, ANY output
// (marker or not) re-arms the idleAfterMs timer — claude's fullscreen-TUI diff repaints only
// paint the marker text once at turn start (afterwards only the animating spinner cell repaints),
// so a fresh marker sighting can't be the liveness signal; continuous output flow is. The timer
// firing with no output in that window flips working off.
//
// The tail is deliberately WIPED the moment we go idle (not just emptied by size), rather than
// left to decay by 4KB of unrelated future output: without that, a stale marker sighting could
// re-trigger a false ON from an unrelated keystroke echo (e.g. while the human is slowly typing a
// new prompt) right after claude actually went idle.
export function createOutputScanner(onWorkingChange: (on: boolean) => void, opts?: OutputScannerOptions): OutputScanner {
  const idleAfterMs = opts?.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS;
  const onNotice = opts?.onNotice;
  const readyQuietMs = opts?.readyQuietMs ?? DEFAULT_READY_QUIET_MS;
  const onReady = opts?.onReady;
  let tail = '';
  let working = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  // Notice-detection state — deliberately separate from the working-marker `tail` above (which
  // gets wiped on idle transitions); a build failure or URL sighting must not depend on whether
  // claude currently looks "working".
  let lineBuf = '';
  const lastNoticeAt = new Map<string, number>(); // `${kind}|${text}` -> last emitted ms
  let lastAnyNoticeAt = 0;

  // Readiness-detection state — see the "TUI readiness detection" comment above.
  let readyTail = '';
  let sawAltScreen = false;
  let sawBracketedPaste = false;
  let ready = false;
  let readyQuietTimer: ReturnType<typeof setTimeout> | null = null;

  function clearIdleTimer(): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function clearReadyQuietTimer(): void {
    if (readyQuietTimer) {
      clearTimeout(readyQuietTimer);
      readyQuietTimer = null;
    }
  }

  // Fires onReady() exactly once, after both boot sequences have been seen AND output has gone
  // quiet for readyQuietMs. Re-armed on every chunk once both flags are set, so it only fires once
  // the boot paint has actually settled rather than the instant the second marker appears. A
  // scanner that never sees both sequences never arms the timer and so never fires.
  function scanForReady(chunk: string): void {
    if (ready) return;
    readyTail = (readyTail + chunk).slice(-READY_TAIL_MAX_BYTES);
    if (!sawAltScreen && readyTail.includes(ALT_SCREEN_ON_SEQ)) sawAltScreen = true;
    if (!sawBracketedPaste && readyTail.includes(BRACKETED_PASTE_ON_SEQ)) sawBracketedPaste = true;
    if (!sawAltScreen || !sawBracketedPaste) return;
    clearReadyQuietTimer();
    readyQuietTimer = setTimeout(() => {
      readyQuietTimer = null;
      ready = true;
      onReady?.();
    }, readyQuietMs);
  }

  function goIdle(): void {
    idleTimer = null;
    working = false;
    tail = ''; // drop the stale marker text — see the "wiped" note above
    onWorkingChange(false);
  }

  function emitNotice(found: { kind: NoticeKind; text: string }): void {
    if (!onNotice) return;
    const now = Date.now();
    if (now - lastAnyNoticeAt < NOTICE_MIN_INTERVAL_MS) return;
    const key = `${found.kind}|${found.text}`;
    const last = lastNoticeAt.get(key);
    if (last !== undefined && now - last < NOTICE_DEDUP_WINDOW_MS) return;
    lastNoticeAt.set(key, now);
    lastAnyNoticeAt = now;
    onNotice(found.kind, found.text);
  }

  function scanForNotices(chunk: string): void {
    if (!onNotice) return;
    lineBuf += chunk;
    if (lineBuf.length > LINE_BUF_MAX_CHARS) lineBuf = lineBuf.slice(-LINE_BUF_MAX_CHARS);
    const lines = lineBuf.split(SEGMENT_END_RE);
    lineBuf = lines.pop() ?? ''; // keep the trailing partial segment for the next feed()
    for (const line of lines) {
      const found = detectNotice(line);
      if (found) emitNotice(found);
    }
  }

  return {
    feed(chunk: string): void {
      scanForNotices(chunk);
      scanForReady(chunk);

      tail = (tail + chunk).slice(-TAIL_MAX_BYTES);
      if (working) {
        // Sustain on ANY output: fullscreen-TUI diff repaints emit the marker text once per
        // turn (only the spinner cell changes per frame), so marker re-sighting can't be the
        // liveness signal — continuous output flow is. Cost: echoes of uninterrupted typing
        // right after a turn can stretch 'working' by a few seconds; benign for both consumers
        // (toast suppression while the human is at the keyboard, admin ⚡).
        clearIdleTimer();
        idleTimer = setTimeout(goIdle, idleAfterMs);
        return;
      }
      if (!containsRunMarker(tail)) return;
      working = true;
      onWorkingChange(true);
      clearIdleTimer();
      idleTimer = setTimeout(goIdle, idleAfterMs);
    },
    stop(): void {
      clearIdleTimer();
      clearReadyQuietTimer();
    },
    isWorking(): boolean {
      return working;
    },
    isReady(): boolean {
      return ready;
    },
  };
}
