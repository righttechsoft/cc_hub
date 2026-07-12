import { describe, expect, it } from 'vitest';
import { computeAway } from './awayDetector.js';

const THRESHOLD_MS = 3 * 60_000;

describe('computeAway', () => {
  it('treats a null sample (no detector data yet) as away', () => {
    expect(computeAway(null, 1_000_000, THRESHOLD_MS)).toBe(true);
  });

  it('treats a stale sample (>60s old) as away', () => {
    const sample = { idleMs: 0, receivedAt: 0 };
    expect(computeAway(sample, 60_001, THRESHOLD_MS)).toBe(true);
  });

  it('is not away when a fresh sample is below the threshold', () => {
    const sample = { idleMs: 10_000, receivedAt: 0 };
    expect(computeAway(sample, 5_000, THRESHOLD_MS)).toBe(false);
  });

  it('is away once idleMs plus elapsed time since the sample crosses the threshold', () => {
    const sample = { idleMs: THRESHOLD_MS - 1_000, receivedAt: 0 };
    expect(computeAway(sample, 2_000, THRESHOLD_MS)).toBe(true);
  });
});
