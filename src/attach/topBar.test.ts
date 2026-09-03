import { describe, expect, it } from 'vitest';
import { createTopBar, sanitizeStatus, shiftInputRows } from './topBar.js';

describe('createTopBar.translate', () => {
  it('shifts CUP rows down by one', () => {
    const bar = createTopBar(24, 80);
    expect(bar.translate('\x1b[5;10H')).toBe('\x1b[6;10H');
  });

  it('applies CUP defaults', () => {
    const bar = createTopBar(24, 80);
    expect(bar.translate('\x1b[H')).toBe('\x1b[2;1H');
    expect(bar.translate('\x1b[;7H')).toBe('\x1b[2;7H');
  });

  it('shifts HVP rows down by one', () => {
    const bar = createTopBar(24, 80);
    expect(bar.translate('\x1b[3;4f')).toBe('\x1b[4;4H');
  });

  it('shifts VPA rows down by one', () => {
    const bar = createTopBar(24, 80);
    expect(bar.translate('\x1b[7d')).toBe('\x1b[8d');
    expect(bar.translate('\x1b[d')).toBe('\x1b[2d');
  });

  it('shifts DECSTBM margins, mapping bare reset to the protected region', () => {
    const bar = createTopBar(24, 80);
    expect(bar.translate('\x1b[1;23r')).toBe('\x1b[2;24r');
    expect(bar.translate('\x1b[r')).toBe('\x1b[2;24r');
  });

  it('leaves private mode sequences untouched', () => {
    const bar = createTopBar(24, 80);
    expect(bar.translate('\x1b[?25h')).toBe('\x1b[?25h');
    const out = bar.translate('\x1b[?1049h');
    expect(out.startsWith('\x1b[?1049h')).toBe(true);
    expect(out).toContain('\x1b[2;24r');
  });

  it('leaves SGR/plain text and relative cursor moves untouched', () => {
    const bar = createTopBar(24, 80);
    expect(bar.translate('\x1b[31mred\x1b[0m')).toBe('\x1b[31mred\x1b[0m');
    expect(bar.translate('\x1b[3A\x1b[2B')).toBe('\x1b[3A\x1b[2B');
  });

  it('holds a split CUP across chunks', () => {
    const bar = createTopBar(24, 80);
    expect(bar.translate('\x1b[12;')).toBe('');
    expect(bar.translate('34H')).toBe('\x1b[13;34H');
  });

  it('repaints row 1 after a 2J screen clear', () => {
    const bar = createTopBar(24, 80);
    bar.setStatus('S');
    const out = bar.translate('\x1b[2J');
    expect(out.startsWith('\x1b[2J')).toBe(true);
    expect(out).toContain('\x1b7\x1b[1;1H');
    expect(out).toContain('S');
    expect(out).toContain('\x1b8');
  });
});

describe('createTopBar.setStatus', () => {
  it('paints only on actual change', () => {
    const bar = createTopBar(24, 80);
    expect(bar.setStatus('S')).toContain('S');
    expect(bar.setStatus('S')).toBe('');
    expect(bar.setStatus('T')).toContain('T');
    expect(bar.setStatus('')).toBe('');
  });

  it('truncates plain text over the column width and keeps SGR for text that fits', () => {
    const bar = createTopBar(24, 80);
    const long = 'x'.repeat(100);
    const painted = bar.setStatus(long);
    expect(painted).toContain('x'.repeat(79));
    expect(painted).not.toContain('x'.repeat(80));

    const bar2 = createTopBar(24, 80);
    const withSgr = '\x1b[36mhello\x1b[0m';
    expect(bar2.setStatus(withSgr)).toContain('\x1b[36m');
  });
});

describe('sanitizeStatus', () => {
  it('keeps SGR, strips control bytes (ESC/BEL/etc.), and keeps only the first line', () => {
    // Only SGR ("\x1b[...m") sequences survive intact; other escapes lose their control bytes
    // (ESC, BEL) but the printable payload between them is not otherwise removed.
    expect(sanitizeStatus('\x1b[36mhi\x1b]0;x\x07\x01\nsecond')).toBe('\x1b[36mhi]0;x');
  });
});

describe('createTopBar.resize', () => {
  it('re-establishes margins for the new geometry', () => {
    const bar = createTopBar(24, 80);
    expect(bar.resize(30, 120)).toContain('\x1b[2;30r');
  });
});

describe('createTopBar lastCup re-assert', () => {
  it('re-emits the last translated CUP after a buffer-switch sequence', () => {
    const bar = createTopBar(24, 80);
    bar.translate('\x1b[5;5H');
    const out = bar.translate('\x1b[?1049h');
    expect(out.endsWith('\x1b[6;5H')).toBe(true);
  });
});

describe('shiftInputRows', () => {
  it('shifts CPR replies down by one, clamping row 1', () => {
    expect(shiftInputRows('\x1b[10;5R')).toBe('\x1b[9;5R');
    expect(shiftInputRows('\x1b[1;2R')).toBe('\x1b[1;2R');
  });

  it('shifts SGR mouse press/release rows down by one', () => {
    expect(shiftInputRows('\x1b[<0;42;10M')).toBe('\x1b[<0;42;9M');
    expect(shiftInputRows('\x1b[<0;42;10m')).toBe('\x1b[<0;42;9m');
  });

  it('shifts SGR mouse wheel rows down by one', () => {
    expect(shiftInputRows('\x1b[<64;5;3M')).toBe('\x1b[<64;5;2M');
  });

  it('clamps a click on the bar itself to child row 1', () => {
    expect(shiftInputRows('\x1b[<0;1;1M')).toBe('\x1b[<0;1;1M');
  });

  it('leaves columns and unrelated text/sequences untouched', () => {
    expect(shiftInputRows('hello\x1b[?1006h')).toBe('hello\x1b[?1006h');
  });
});
