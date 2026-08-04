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

export interface OutputScannerOptions {
  idleAfterMs?: number;
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
  let tail = '';
  let working = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

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

  return {
    feed(chunk: string): void {
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
