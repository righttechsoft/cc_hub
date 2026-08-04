// Detects whether claude is actively WORKING (turn/tool/subagent in progress) purely from the
// pty output bytes the wrapper already sees. The hub-side session status is unreliable during
// subagent (Task) work, so this gives desktopNotifier/pushNotifier a truth signal straight from
// the terminal: claude shows a live "esc to interrupt" running indicator while a turn, tool, or
// subagent is running, and clears it once it's back at the prompt. We don't parse the screen —
// just watch for that substring appearing/disappearing in the byte stream.
const ANSI_ESCAPE_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][A-Za-z0-9]|\x1b[=>]/g;
const RUN_MARKER = 'esc to interrupt';

// How much recent (ANSI-included) output to keep for matching — big enough that a marker split
// across two pty chunks is still caught, small enough to stay cheap per feed() call.
const TAIL_MAX_BYTES = 4096;

// How long to wait after the last marker sighting before declaring claude idle. claude redraws
// the running indicator frequently while active, so any real gap this long means the turn ended.
const DEFAULT_IDLE_AFTER_MS = 1500;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_ESCAPE_RE, '');
}

export function containsRunMarker(s: string): boolean {
  return stripAnsi(s).toLowerCase().includes(RUN_MARKER);
}

// --- Output notice triggers (build/test failures, local dev-server URLs) -----------------------
// Independent of the working-marker tail/idle machinery above: scans complete lines of pty output
// for a small, tightly-anchored set of markers and reports them via onNotice so cc-attach can push
// a hub notification. Deliberately conservative — this drives OS toasts, so false positives are
// worse than misses: only complete lines are scanned (a marker split across two feed() calls is
// buffered until the newline arrives) and repeats are de-duplicated/rate-limited.

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

const NOTICE_TEXT_MAX_CHARS = 200;
// A repeat of the same kind+text within this window is suppressed — a failing watch-loop or a dev
// server reprinting its banner must not toast-storm.
const NOTICE_DEDUP_WINDOW_MS = 30_000;
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
    return { kind: 'url', text: urlMatch[0].replace('0.0.0.0', 'localhost') };
  }
  return null;
}

export interface OutputScannerOptions {
  idleAfterMs?: number;
  onNotice?: (kind: NoticeKind, text: string) => void;
}

export interface OutputScanner {
  feed(chunk: string): void;
  stop(): void;
}

// createOutputScanner(onWorkingChange): feed() is called from the pty's onData handler with each
// raw chunk. A chunk (or the rolling tail it lands in) containing the marker flips working on —
// once — and (re)arms an idleAfterMs timer; the timer firing with no fresh sighting flips it off.
//
// The tail is deliberately WIPED the moment we go idle (not just emptied by size), rather than
// left to decay by 4KB of unrelated future output: without that, the marker text would keep
// matching on every feed() call for a long stretch after claude actually went idle (e.g. while
// the human is slowly typing a new prompt, whose echoed keystrokes are tiny relative to 4KB),
// producing a false "still working" read right when we most need the real state.
export function createOutputScanner(onWorkingChange: (on: boolean) => void, opts?: OutputScannerOptions): OutputScanner {
  const idleAfterMs = opts?.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS;
  const onNotice = opts?.onNotice;
  let tail = '';
  let working = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  // Notice-detection state — deliberately separate from the working-marker `tail` above (which
  // gets wiped on idle transitions); a build failure or URL sighting must not depend on whether
  // claude currently looks "working".
  let lineBuf = '';
  const lastNoticeAt = new Map<string, number>(); // `${kind}|${text}` -> last emitted ms
  let lastAnyNoticeAt = 0;

  function clearIdleTimer(): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
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
    const lines = lineBuf.split('\n');
    lineBuf = lines.pop() ?? ''; // keep the trailing partial line for the next feed()
    for (const line of lines) {
      const found = detectNotice(line);
      if (found) emitNotice(found);
    }
  }

  return {
    feed(chunk: string): void {
      scanForNotices(chunk);

      tail = (tail + chunk).slice(-TAIL_MAX_BYTES);
      if (!containsRunMarker(tail)) return;
      if (!working) {
        working = true;
        onWorkingChange(true);
      }
      clearIdleTimer();
      idleTimer = setTimeout(goIdle, idleAfterMs);
    },
    stop(): void {
      clearIdleTimer();
    },
  };
}
