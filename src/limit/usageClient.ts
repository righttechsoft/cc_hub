import type { Usage } from '../types.js';

export type UsageErrorKind = 'auth' | 'net' | 'parse' | 'rate_limited';

export class UsageError extends Error {
  kind: UsageErrorKind;

  constructor(kind: UsageErrorKind, message: string) {
    super(message);
    this.name = 'UsageError';
    this.kind = kind;
  }
}

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const TIMEOUT_MS = 10_000;
const PCT_KEYS = ['utilization', 'percent', 'used', 'percentage'] as const;
const RESET_KEYS = ['resets_at', 'reset_at', 'reset'] as const;

function extractNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// number > 1e10 is already milliseconds; a plain epoch-seconds number gets scaled up.
// ISO strings go through Date.parse; unparsable strings yield null rather than NaN.
function extractEpochMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v > 1e10 ? v : v * 1000;
  }
  if (typeof v === 'string') {
    const parsed = Date.parse(v);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

// Exported standalone so pct/resets_at fallback-chain parsing can be unit tested without
// mocking global fetch. Mirrors parse_usage in F:\rts\cc_limit\src\main.rs:296-309.
export function parseUsage(json: unknown): Usage {
  if (typeof json !== 'object' || json === null) {
    throw new UsageError('parse', 'usage response is not a JSON object');
  }
  const root = json as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(root, 'five_hour')) {
    throw new UsageError('parse', 'no five_hour field');
  }
  const fiveHour = root.five_hour;
  const fiveHourObj =
    typeof fiveHour === 'object' && fiveHour !== null ? (fiveHour as Record<string, unknown>) : null;

  let pct: number | null = null;
  if (fiveHourObj) {
    for (const key of PCT_KEYS) {
      const n = extractNumber(fiveHourObj[key]);
      if (n !== null) {
        pct = n;
        break;
      }
    }
  }
  if (pct === null) pct = extractNumber(fiveHour);
  if (pct === null) throw new UsageError('parse', 'no pct in five_hour');
  if (pct <= 1.0) pct *= 100;

  let resetsAtMs: number | null = null;
  if (fiveHourObj) {
    for (const key of RESET_KEYS) {
      const e = extractEpochMs(fiveHourObj[key]);
      if (e !== null) {
        resetsAtMs = e;
        break;
      }
    }
  }

  return { pct, resetsAtMs, raw: json };
}

export async function fetchUsage(token: string): Promise<Usage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(USAGE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: controller.signal,
    });
  } catch (err) {
    throw new UsageError('net', err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    throw new UsageError('auth', `usage endpoint returned ${res.status}`);
  }
  if (res.status === 429) {
    throw new UsageError('rate_limited', `usage endpoint returned ${res.status}`);
  }
  if (!res.ok) {
    throw new UsageError('net', `usage endpoint returned ${res.status}`);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (err) {
    throw new UsageError('parse', err instanceof Error ? err.message : String(err));
  }

  return parseUsage(json);
}
