import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { HubConfig, Logger } from './types.js';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;

const MAX_BYTES = 1024 * 1024;

export function createLogger(level: HubConfig['logLevel'], file: string): Logger {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const threshold = LEVELS[level];

  function rotateIfNeeded(): void {
    if (!existsSync(file)) return;
    const { size } = statSync(file);
    if (size >= MAX_BYTES) {
      const old = file + '.old';
      renameSync(file, old);
    }
  }

  function write(lvl: keyof typeof LEVELS, msg: string, extra?: unknown): void {
    if (LEVELS[lvl] < threshold) return;
    const line = formatLine(lvl, msg, extra);

    const consoleFn = lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log;
    consoleFn(line);

    rotateIfNeeded();
    appendFileSync(file, line + '\n');
  }

  function formatLine(lvl: keyof typeof LEVELS, msg: string, extra?: unknown): string {
    const ts = new Date().toISOString();
    const base = `[${ts}] [${lvl.toUpperCase()}] ${msg}`;
    if (extra === undefined) return base;
    try {
      return `${base} ${JSON.stringify(extra)}`;
    } catch {
      return `${base} ${String(extra)}`;
    }
  }

  return {
    debug: (msg, extra) => write('debug', msg, extra),
    info: (msg, extra) => write('info', msg, extra),
    warn: (msg, extra) => write('warn', msg, extra),
    error: (msg, extra) => write('error', msg, extra),
  };
}
