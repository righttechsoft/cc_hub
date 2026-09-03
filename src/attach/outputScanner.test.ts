import { describe, expect, it, vi, afterEach } from 'vitest';
import { containsRunMarker, createOutputScanner, stripAnsi, RUN_MARKER_PATTERNS } from './outputScanner.js';

describe('stripAnsi', () => {
  it('removes CSI sequences', () => {
    expect(stripAnsi('\x1b[2K\x1b[1Ghello')).toBe('hello');
  });

  it('leaves plain text unchanged', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });

  it('removes a colored "esc to interrupt" style sequence around the text', () => {
    expect(stripAnsi('\x1b[2mesc to interrupt\x1b[0m')).toBe('esc to interrupt');
  });
});

describe('containsRunMarker', () => {
  it('exports exactly the 4 documented patterns', () => {
    expect(RUN_MARKER_PATTERNS).toHaveLength(4);
  });

  // Legacy marker (pattern 1) — older CC versions.
  it('matches the legacy "esc to interrupt" marker case-insensitively', () => {
    expect(containsRunMarker('Working… (ESC to Interrupt)')).toBe(true);
  });

  it('matches the legacy marker through ANSI styling', () => {
    expect(containsRunMarker('\x1b[2mesc to interrupt\x1b[0m')).toBe(true);
  });

  // Current CC (v2.1.251) prints no "esc to interrupt" text at all — a live capture of a session
  // actively mid-turn contained not even the word "interrupt" anywhere in its 64KB output ring.
  // Patterns 2-4 below were derived from that capture's status line fragments instead.
  it('matches the elapsed-time counter opening the status line, e.g. "(30s ·"', () => {
    expect(containsRunMarker('(30s · thinking with xhigh effort)')).toBe(true);
  });

  it('matches the token counter closing the status line, e.g. "5.5k tokens)"', () => {
    expect(containsRunMarker('30s ·  5.5k tokens)')).toBe(true);
  });

  it('matches the "thinking with <effort> effort" fragment', () => {
    expect(containsRunMarker('· thinking with xhigh effort)')).toBe(true);
  });

  it('matches each pattern through ANSI styling around it', () => {
    expect(containsRunMarker('\x1b[2m(30s ·\x1b[0m')).toBe(true);
    expect(containsRunMarker('\x1b[2m5.5k tokens)\x1b[0m')).toBe(true);
    expect(containsRunMarker('\x1b[2mthinking with xhigh effort\x1b[0m')).toBe(true);
  });

  it('returns false when no marker is present', () => {
    expect(containsRunMarker('just a normal prompt')).toBe(false);
  });

  // Negative cases — patterns 2-4 are deliberately status-line-shaped (a counter in parentheses)
  // to limit false positives from ordinary conversation text.
  it('does not match plain prose mentioning "tokens" without the parenthesized status-line shape', () => {
    expect(containsRunMarker('This model can handle up to 200000 tokens per request.')).toBe(false);
  });

  it('does not match a bare "<number>s" with no opening parenthesis', () => {
    expect(containsRunMarker('The build finished in 30s total.')).toBe(false);
  });
});

describe('createOutputScanner', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports working=true once on the first marker sighting, not again on repeats', () => {
    const onChange = vi.fn();
    const scanner = createOutputScanner(onChange, { idleAfterMs: 1000 });

    scanner.feed('esc to interrupt');
    scanner.feed('still esc to interrupt');

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
    scanner.stop();
  });

  it('reports working=false after idleAfterMs with no fresh sighting', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const scanner = createOutputScanner(onChange, { idleAfterMs: 1000 });

    scanner.feed('esc to interrupt');
    vi.advanceTimersByTime(999);
    expect(onChange).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(false);
    scanner.stop();
  });

  it('a fresh sighting before the idle timer fires resets the debounce window', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const scanner = createOutputScanner(onChange, { idleAfterMs: 1000 });

    scanner.feed('esc to interrupt');
    vi.advanceTimersByTime(800);
    scanner.feed('esc to interrupt'); // re-arms before the 1000ms window elapses
    vi.advanceTimersByTime(800);
    expect(onChange).toHaveBeenCalledTimes(1); // still just the initial true — never flipped false

    vi.advanceTimersByTime(300);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(false);
    scanner.stop();
  });

  it('catches a marker split across two feed() calls via the rolling tail', () => {
    const onChange = vi.fn();
    const scanner = createOutputScanner(onChange, { idleAfterMs: 1000 });

    scanner.feed('spinner… esc to inter');
    scanner.feed('rupt');

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
    scanner.stop();
  });

  it('does not call onWorkingChange for chunks that never contain the marker', () => {
    const onChange = vi.fn();
    const scanner = createOutputScanner(onChange, { idleAfterMs: 1000 });

    scanner.feed('just some normal output\n');
    scanner.feed('another line\n');

    expect(onChange).not.toHaveBeenCalled();
    scanner.stop();
  });

  it('after going idle, unrelated later output does not re-trigger a false working=true', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const scanner = createOutputScanner(onChange, { idleAfterMs: 1000 });

    scanner.feed('esc to interrupt');
    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledTimes(2); // true, then false
    onChange.mockClear();

    // Small unrelated chunks (e.g. echoed keystrokes while typing a new prompt) that don't
    // themselves contain the marker must not resurrect the stale sighting from before idle.
    scanner.feed('a');
    scanner.feed('b');
    scanner.feed('c');

    expect(onChange).not.toHaveBeenCalled();
    scanner.stop();
  });

  it('a marker seen early in a long marker-less stream (>4KB, <32KB later) still flips working on', () => {
    const onChange = vi.fn();
    const scanner = createOutputScanner(onChange, { idleAfterMs: 1000 });

    // The marker lands first, then >4KB (but <32KB) of marker-less filler follows before the
    // regex is ever evaluated again on a fresh feed() — this reproduces claude's diff-repaint
    // behavior, where the status line marker doesn't recur within a small trailing window.
    scanner.feed('esc to interrupt');
    scanner.feed('x'.repeat(5000));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
    scanner.stop();
  });

  it('after goIdle wipes the tail, marker-less output alone does not re-trigger working even past 4KB', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const scanner = createOutputScanner(onChange, { idleAfterMs: 1000 });

    scanner.feed('esc to interrupt');
    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledTimes(2); // true, then false (goIdle wiped the tail)
    onChange.mockClear();

    scanner.feed('y'.repeat(5000));
    expect(onChange).not.toHaveBeenCalled();
    scanner.stop();
  });

  it('stop() prevents a pending idle timer from firing', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const scanner = createOutputScanner(onChange, { idleAfterMs: 1000 });

    scanner.feed('esc to interrupt');
    scanner.stop();
    vi.advanceTimersByTime(5000);

    expect(onChange).toHaveBeenCalledTimes(1); // only the initial true — stop() cancelled the idle flip
  });

  it('sustains working across marker-less output, goes idle only after total silence, and re-arms on a fresh marker after idle', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const scanner = createOutputScanner(onChange, { idleAfterMs: 1000 });

    scanner.feed('esc to interrupt');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(scanner.isWorking()).toBe(true);

    // Marker-less output (e.g. just the animating spinner cell, as a fullscreen-TUI diff repaint
    // produces) every 500ms for 5 simulated seconds must sustain working — continuous output flow
    // is the liveness signal now, not marker re-sighting.
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(500);
      scanner.feed('spinner frame');
    }
    expect(onChange).toHaveBeenCalledTimes(1); // still just the initial true
    expect(scanner.isWorking()).toBe(true);

    // No further feeds: after idleAfterMs + 100 of total silence, working flips off exactly once.
    vi.advanceTimersByTime(1100);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(scanner.isWorking()).toBe(false);

    // While idle, marker-less output (keystroke echoes) must not resurrect working.
    scanner.feed('a');
    scanner.feed('b');
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(scanner.isWorking()).toBe(false);

    // A fresh marker sighting after goIdle wiped the tail flips working on again.
    scanner.feed('esc to interrupt');
    expect(onChange).toHaveBeenCalledTimes(3);
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(scanner.isWorking()).toBe(true);

    scanner.stop();
  });
});

describe('createOutputScanner notice detection', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires a build_failed notice once for each distinctive marker line', () => {
    const markers = [
      'npm error command failed',
      'npm ERR! code ENOENT',
      'BUILD FAILED (10 errors)',
      "src/index.ts(10,5): error TS2345: Argument of type 'string' is not assignable",
      'Traceback (most recent call last):',
      'error[E0432]: unresolved import `foo`',
      'FAILED (failures=1)',
      'Tests:       1 failed, 5 passed, 6 total',
      'FAIL src/foo.test.ts',
      'panic: runtime error: invalid memory address or nil pointer dereference',
      'pytest session: 1 failed, 4 passed',
    ];
    for (const line of markers) {
      const onNotice = vi.fn();
      const scanner = createOutputScanner(() => {}, { onNotice });
      scanner.feed(`${line}\n`);
      expect(onNotice).toHaveBeenCalledTimes(1);
      expect(onNotice.mock.calls[0][0]).toBe('build_failed');
      scanner.stop();
    }
  });

  it('does not fire a notice for a plain internet URL', () => {
    const onNotice = vi.fn();
    const scanner = createOutputScanner(() => {}, { onNotice });

    scanner.feed('Check out https://example.com for more info\n');

    expect(onNotice).not.toHaveBeenCalled();
    scanner.stop();
  });

  it('fires a url notice for a localhost dev-server URL', () => {
    const onNotice = vi.fn();
    const scanner = createOutputScanner(() => {}, { onNotice });

    scanner.feed('  ➜  Local:   http://localhost:5173/\n');

    expect(onNotice).toHaveBeenCalledWith('url', 'http://localhost:5173/');
    scanner.stop();
  });

  it('normalizes 0.0.0.0 to localhost in the reported url text', () => {
    const onNotice = vi.fn();
    const scanner = createOutputScanner(() => {}, { onNotice });

    scanner.feed('Server running at http://0.0.0.0:8080\n');

    expect(onNotice).toHaveBeenCalledWith('url', 'http://localhost:8080');
    scanner.stop();
  });

  it('suppresses a repeat of the same notice within the dedup window', () => {
    vi.useFakeTimers();
    const onNotice = vi.fn();
    const scanner = createOutputScanner(() => {}, { onNotice });

    scanner.feed('npm ERR! code E404\n');
    expect(onNotice).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(300_000);
    scanner.feed('npm ERR! code E404\n');
    expect(onNotice).toHaveBeenCalledTimes(1); // still within the 10min window

    vi.advanceTimersByTime(310_000); // 610s since the first sighting
    scanner.feed('npm ERR! code E404\n');
    expect(onNotice).toHaveBeenCalledTimes(2);

    scanner.stop();
  });

  it('catches a marker split across two feed() calls via the line buffer', () => {
    const onNotice = vi.fn();
    const scanner = createOutputScanner(() => {}, { onNotice });

    scanner.feed('npm ER');
    scanner.feed('R! code E404\n');

    expect(onNotice).toHaveBeenCalledTimes(1);
    expect(onNotice).toHaveBeenCalledWith('build_failed', 'npm ERR! code E404');
    scanner.stop();
  });

  it('does not call onNotice when no callback is provided', () => {
    const scanner = createOutputScanner(() => {});
    expect(() => scanner.feed('npm ERR! code E404\n')).not.toThrow();
    scanner.stop();
  });

  it('detects a URL notice in TUI-framed output with no newlines', () => {
    const onNotice = vi.fn();
    const scanner = createOutputScanner(() => {}, { onNotice });

    scanner.feed('\x1b[H\r\x1b[7Ccurl -s http://localhost:47311/healthz; echo\x1b[39m\x1b[53;1H\x1b[50;3Hnext');

    expect(onNotice).toHaveBeenCalledTimes(1);
    expect(onNotice).toHaveBeenCalledWith('url', 'http://localhost:47311/healthz');
    scanner.stop();
  });

  it('detects a build_failed notice in TUI-framed output with no newlines', () => {
    const onNotice = vi.fn();
    const scanner = createOutputScanner(() => {}, { onNotice });

    scanner.feed('\x1b[10;1Hnpm error code ELIFECYCLE\x1b[11;1Hmore text');

    expect(onNotice).toHaveBeenCalledTimes(1);
    expect(onNotice.mock.calls[0][0]).toBe('build_failed');
    expect(onNotice.mock.calls[0][1]).toContain('npm error');
    scanner.stop();
  });

  it('detects a URL notice framed only by carriage returns', () => {
    const onNotice = vi.fn();
    const scanner = createOutputScanner(() => {}, { onNotice });

    scanner.feed('building...\rhttp://127.0.0.1:5173/\rdone\n');

    expect(onNotice).toHaveBeenCalledWith('url', 'http://127.0.0.1:5173/');
    scanner.stop();
  });

  it('suppresses a repeated TUI repaint of the same segment', () => {
    const onNotice = vi.fn();
    const scanner = createOutputScanner(() => {}, { onNotice });

    const segment = '\x1b[10;1Hhttp://localhost:6001/\x1b[11;1H';
    scanner.feed(segment);
    scanner.feed(segment);

    expect(onNotice).toHaveBeenCalledTimes(1);
    scanner.stop();
  });

  it('catches a segment separator split across two feed() calls', () => {
    const onNotice = vi.fn();
    const scanner = createOutputScanner(() => {}, { onNotice });

    scanner.feed('http://localhost:9999 up\x1b[53');
    scanner.feed(';1Hrest');

    expect(onNotice).toHaveBeenCalledTimes(1);
    expect(onNotice).toHaveBeenCalledWith('url', 'http://localhost:9999');
    scanner.stop();
  });
});

describe('createOutputScanner readiness detection', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not fire onReady with only one of the two boot sequences', () => {
    vi.useFakeTimers();
    const onReady = vi.fn();
    const scanner = createOutputScanner(() => {}, { onReady, readyQuietMs: 1000 });

    scanner.feed('\x1b[?1049h'); // alt screen only, no bracketed-paste
    vi.advanceTimersByTime(10_000);

    expect(onReady).not.toHaveBeenCalled();
    expect(scanner.isReady()).toBe(false);
    scanner.stop();
  });

  it('fires onReady once both sequences (in real boot order — paste mode, then alt screen) have been seen and output has gone quiet', () => {
    vi.useFakeTimers();
    const onReady = vi.fn();
    const scanner = createOutputScanner(() => {}, { onReady, readyQuietMs: 1000 });

    scanner.feed('\x1b[?2004h'); // bracketed paste turns on early during boot
    scanner.feed('boot text in between');
    scanner.feed('\x1b[?1049h'); // alt screen takeover follows
    expect(onReady).not.toHaveBeenCalled();

    vi.advanceTimersByTime(999);
    expect(onReady).not.toHaveBeenCalled();
    expect(scanner.isReady()).toBe(false);

    vi.advanceTimersByTime(2);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(scanner.isReady()).toBe(true);
    scanner.stop();
  });

  it('detects the two sequences order-independently (alt screen before paste mode)', () => {
    vi.useFakeTimers();
    const onReady = vi.fn();
    const scanner = createOutputScanner(() => {}, { onReady, readyQuietMs: 1000 });

    scanner.feed('\x1b[?1049h\x1b[?2004h');
    vi.advanceTimersByTime(1000);

    expect(onReady).toHaveBeenCalledTimes(1);
    scanner.stop();
  });

  it('further output after both sequences re-arms the quiet timer instead of firing immediately', () => {
    vi.useFakeTimers();
    const onReady = vi.fn();
    const scanner = createOutputScanner(() => {}, { onReady, readyQuietMs: 1000 });

    scanner.feed('\x1b[?1049h\x1b[?2004h');
    vi.advanceTimersByTime(800);
    scanner.feed('more boot paint'); // re-arms before the 1000ms window elapses
    vi.advanceTimersByTime(800);
    expect(onReady).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    expect(onReady).toHaveBeenCalledTimes(1);
    scanner.stop();
  });

  it('fires onReady only once, even if the boot sequences reappear later (e.g. a repaint)', () => {
    vi.useFakeTimers();
    const onReady = vi.fn();
    const scanner = createOutputScanner(() => {}, { onReady, readyQuietMs: 1000 });

    scanner.feed('\x1b[?1049h\x1b[?2004h');
    vi.advanceTimersByTime(1000);
    expect(onReady).toHaveBeenCalledTimes(1);

    scanner.feed('\x1b[?1049h\x1b[?2004h');
    vi.advanceTimersByTime(2000);
    expect(onReady).toHaveBeenCalledTimes(1);
    scanner.stop();
  });

  it('a scanner that never sees either sequence never fires onReady', () => {
    vi.useFakeTimers();
    const onReady = vi.fn();
    const scanner = createOutputScanner(() => {}, { onReady, readyQuietMs: 1000 });

    scanner.feed('just normal claude output, no boot sequences here\n');
    vi.advanceTimersByTime(60_000);

    expect(onReady).not.toHaveBeenCalled();
    expect(scanner.isReady()).toBe(false);
    scanner.stop();
  });

  it('catches both sequences split across chunks via the rolling tail', () => {
    vi.useFakeTimers();
    const onReady = vi.fn();
    const scanner = createOutputScanner(() => {}, { onReady, readyQuietMs: 1000 });

    scanner.feed('\x1b[?200'); // bracketed-paste split mid-sequence
    scanner.feed('4h');
    scanner.feed('\x1b[?10'); // alt-screen split mid-sequence
    scanner.feed('49h');

    vi.advanceTimersByTime(1000);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(scanner.isReady()).toBe(true);
    scanner.stop();
  });

  it('stop() cancels a pending ready-quiet timer', () => {
    vi.useFakeTimers();
    const onReady = vi.fn();
    const scanner = createOutputScanner(() => {}, { onReady, readyQuietMs: 1000 });

    scanner.feed('\x1b[?1049h\x1b[?2004h');
    scanner.stop();
    vi.advanceTimersByTime(5000);

    expect(onReady).not.toHaveBeenCalled();
    expect(scanner.isReady()).toBe(false);
  });

  it('does not throw when no onReady callback is provided', () => {
    vi.useFakeTimers();
    const scanner = createOutputScanner(() => {});
    expect(() => scanner.feed('\x1b[?1049h\x1b[?2004h')).not.toThrow();
    vi.advanceTimersByTime(5000);
    expect(scanner.isReady()).toBe(true);
    scanner.stop();
  });
});
