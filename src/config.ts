import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HubConfig } from './types.js';

const defaults: HubConfig = {
  port: 4270,
  bindAddress: '0.0.0.0',
  authToken: '',
  claudePath: 'claude',
  hooks: { postToolUse: false, postToolUseThrottleMs: 2000, permissionWaitMs: 30000 },
  limitWatcher: {
    enabled: true,
    pollIntervalMs: 60000,
    retryIntervalMs: 15000,
    limitedThresholdPct: 100,
    resetJitterMs: 90000,
  },
  autoContinue: {
    enabled: true,
    prompt: 'You were interrupted by a usage limit which has now reset. Continue where you left off.',
    maxPerSessionPerDay: 0,
    maxConcurrent: 1,
    eligibleWindowMinutes: 10,
    transcriptScanWindowMinutes: 360,
    permissionMode: 'default',
  },
  retention: { sessionEventsDays: 14, messagesDays: 90 },
  relay: { enabled: false, url: '', secret: '' },
  chatDelivery: {
    enabled: true,
    tickMs: 30000,
    maxPerSessionPerHour: 20,
    maxSessionIdleAgeMinutes: 0,
    minIdleMinutes: 0,
  },
  athen: { embeddings: true, model: 'Xenova/all-MiniLM-L6-v2' },
  logLevel: 'info',
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(override)) return base;
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override)) {
    const baseValue = (base as Record<string, unknown>)[key];
    result[key] = isPlainObject(baseValue) && isPlainObject(value) ? deepMerge(baseValue, value) : value;
  }
  return result as T;
}

export function loadConfig(configPath?: string): HubConfig {
  const path = configPath ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'config.json');

  let merged: HubConfig = defaults;
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    merged = deepMerge(defaults, parsed);
  }

  if (!merged.authToken || merged.authToken === 'REPLACED_BY_SETUP') {
    throw new Error('authToken is not set in config.json — run npm run setup');
  }

  if (merged.relay.enabled && (!merged.relay.url || !merged.relay.secret)) {
    throw new Error('relay.enabled requires relay.url and relay.secret in config.json');
  }

  return merged;
}
