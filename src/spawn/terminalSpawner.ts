// Opens a new Windows Terminal tab running cc-attach in a given project cwd, under a given
// instance name — the "spawn" half of the AI Overlord's dispatch mode (see
// src/spawn/dispatcher.ts and src/overlord/overlord.ts's resolveDispatchPlan). Windows-only and
// gated on config: `terminalSpawn.enabled=false` or a non-win32 platform makes spawn() an
// unconditional no-op, mirroring attach.enabled's pre-existing "feature off = identical to
// before" contract (see CLAUDE.md's Attach gotchas).
import { spawn as nodeSpawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HubConfig, Logger } from '../types.js';
import { INSTANCE_NAME_RE } from '../core/identity.js';

export interface SpawnRequest {
  cwd: string;
  name: string;
}

export interface TerminalSpawner {
  spawn(req: SpawnRequest): boolean;
}

// Narrow, test-friendly shape of the one child_process.spawn call this module makes — avoids
// dragging node:child_process's full overloaded signature into every fake in every test.
// node:child_process's real `spawn` satisfies this structurally.
export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; detached: boolean; stdio: 'ignore'; shell: boolean }
) => { unref(): void };

export interface TerminalSpawnerDeps {
  config: HubConfig;
  log: Logger;
  // Injectable for tests — defaults to node:child_process's spawn. A test must NEVER let a real
  // process get launched; always pass a fake here.
  spawnFn?: SpawnFn;
}

// repoRoot = two dirs up from this file (src/spawn/terminalSpawner.ts -> src/spawn -> src -> repo
// root), same derivation style as src/index.ts's projectRoot.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LAUNCHER_PATH = join(repoRoot, 'bin', 'cc-attach.cmd');

const HOUR_MS = 60 * 60 * 1000;

// Pure — replaces {cwd}/{name}/{title}/{launcher} placeholders in each array element (a
// placeholder may be embedded inside a larger element, e.g. a future '--dir={cwd}'-style arg).
// NEVER builds a shell string: the caller spawns with shell:false and this exact argv array, so
// there is no quoting/escaping/injection surface regardless of what an untrusted cwd/name/title
// contains. Unknown placeholders (no matching key in `vars`) are left untouched verbatim. Does
// not mutate `template`.
export function buildSpawnArgs(template: string[], vars: Record<string, string>): string[] {
  return template.map((arg) =>
    arg.replace(/\{(\w+)\}/g, (whole, key: string) =>
      Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : whole
    )
  );
}

export function createTerminalSpawner(deps: TerminalSpawnerDeps): TerminalSpawner {
  const { config, log } = deps;
  const spawnFn = deps.spawnFn ?? (nodeSpawn as SpawnFn);

  // In-memory timestamps of spawn attempts, pruned to the trailing hour on each check — mirrors
  // chatDelivery's per-instance hourly cap (counted at attempt, not completion; resets on hub
  // restart). This cap is global (all dispatched tabs), not per-instance — dispatch targets a
  // different instance each time by design, so a per-instance cap would rarely engage.
  let attempts: number[] = [];

  function withinHourlyCap(): boolean {
    const cutoff = Date.now() - HOUR_MS;
    attempts = attempts.filter((t) => t >= cutoff);
    return attempts.length < config.terminalSpawn.maxPerHour;
  }

  function spawn(req: SpawnRequest): boolean {
    const { cwd, name } = req;

    if (!config.terminalSpawn.enabled) {
      log.warn('terminalSpawner: disabled in config, refusing to open a tab', { cwd, name });
      return false;
    }
    if (process.platform !== 'win32') {
      log.warn('terminalSpawner: only supported on win32, refusing to open a tab', { cwd, name });
      return false;
    }
    if (!INSTANCE_NAME_RE.test(name)) {
      log.warn('terminalSpawner: invalid name, refusing to open a tab', { cwd, name });
      return false;
    }
    try {
      if (!statSync(cwd).isDirectory()) {
        log.warn('terminalSpawner: cwd is not a directory, refusing to open a tab', { cwd, name });
        return false;
      }
    } catch {
      log.warn('terminalSpawner: cwd does not exist, refusing to open a tab', { cwd, name });
      return false;
    }
    if (!withinHourlyCap()) {
      log.warn('terminalSpawner: hourly cap reached, refusing to open a tab', {
        cwd,
        name,
        maxPerHour: config.terminalSpawn.maxPerHour,
      });
      return false;
    }

    // Counted at attempt (before the child actually spawns) — a detached, stdio:'ignore' child
    // gives no reliable async signal of success/failure, so "attempted" is the only countable
    // event, same reasoning as chatDelivery's spawn-cap.
    attempts.push(Date.now());
    try {
      const args = buildSpawnArgs(config.terminalSpawn.args, { cwd, name, title: name, launcher: LAUNCHER_PATH });
      const child = spawnFn(config.terminalSpawn.command, args, { cwd, detached: true, stdio: 'ignore', shell: false });
      child.unref();
      log.info('terminalSpawner: opened tab', { cwd, name });
      return true;
    } catch (err) {
      log.warn('terminalSpawner: spawn threw', { cwd, name, error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  return { spawn };
}
