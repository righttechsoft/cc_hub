import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Recursively searches objects/arrays for the first string value stored under `key`,
// checking each container's own key before descending into its children (matches the
// Rust reference's find_string_key in F:\rts\cc_limit\src\main.rs:196-219).
function findStringKey(value: unknown, key: string): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringKey(item, key);
      if (found !== null) return found;
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj[key] === 'string') return obj[key] as string;
    for (const child of Object.values(obj)) {
      const found = findStringKey(child, key);
      if (found !== null) return found;
    }
    return null;
  }
  return null;
}

// Reads the CC credentials file fresh on every call (never cached) — Claude Code rewrites
// this file in place on token refresh, so a stale in-memory copy would go stale silently.
export function readAccessToken(): string | null {
  try {
    const profile = process.env.USERPROFILE ?? '';
    const path = join(profile, '.claude', '.credentials.json');
    const text = readFileSync(path, 'utf8');
    const parsed: unknown = JSON.parse(text);
    return findStringKey(parsed, 'accessToken') ?? findStringKey(parsed, 'access_token');
  } catch {
    return null;
  }
}
