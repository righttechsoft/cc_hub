import { describe, expect, it, vi, afterEach } from 'vitest';
import { containsRunMarker, createOutputScanner, stripAnsi } from './outputScanner.js';

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
  it('matches the marker case-insensitively', () => {
    expect(containsRunMarker('Working… (ESC to Interrupt)')).toBe(true);
  });

  it('matches through ANSI styling around the marker', () => {
    expect(containsRunMarker('\x1b[2mesc to interrupt\x1b[0m')).toBe(true);
  });

  it('returns false when the marker is absent', () => {
    expect(containsRunMarker('just a normal prompt')).toBe(false);
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

  it('stop() prevents a pending idle timer from firing', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const scanner = createOutputScanner(onChange, { idleAfterMs: 1000 });

    scanner.feed('esc to interrupt');
    scanner.stop();
    vi.advanceTimersByTime(5000);

    expect(onChange).toHaveBeenCalledTimes(1); // only the initial true — stop() cancelled the idle flip
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

    vi.advanceTimersByTime(10_000);
    scanner.feed('npm ERR! code E404\n');
    expect(onNotice).toHaveBeenCalledTimes(1); // still within the 30s window

    vi.advanceTimersByTime(21_000); // 31s since the first sighting
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
});
