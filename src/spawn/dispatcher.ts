// AI Overlord dispatch mode's execution half (the decision half lives in
// src/overlord/overlord.ts's resolveDispatchPlan, which calls decideDispatch below to build the
// DispatchAction a human confirms in the admin page). Once confirmed (POST
// /api/v1/admin/overlord-dispatch in apiRoutes.ts), createDispatcher's dispatch() either injects
// straight into an already-attached idle terminal, or opens a brand-new one (via
// src/spawn/terminalSpawner.ts) and injects once it's actually ready — never throws; every path
// resolves to a `via` outcome the admin route renders.
//
// Registration over /attach is NOT readiness: a live capture showed the wrapper's WS registers
// ~1.5s into boot, long before claude's TUI can accept a paste (bracketed-paste mode turns on
// early, but the alt-screen takeover + boot repaint that follow can still swallow an injection
// landing mid-transition). So the spawn path waits for the wrapper's own {t:'ready'} signal (see
// src/attach/outputScanner.ts + attachRegistry's isReadyByName/isReady) instead of a fixed delay
// after registration.
//
// Verifying an injection landed does NOT probe the terminal's own output ring for the pasted
// text: claude's fullscreen TUI is painted by ConPTY *diff repaints*, so pasted text never appears
// as contiguous bytes in the output stream (same root cause as the notice-scanner's newline bug —
// see CLAUDE.md). A live run proved this false-negative: a dispatched task ran to completion while
// the ring-probe reported "not confirmed" and re-injected a duplicate paste.
//
// Verification is hub-recorded session activity, not a UI-derived signal: when claude accepts and
// submits the injected prompt it fires the UserPromptSubmit hook, which the hub already records as
// a session_events row and (for the session's own status) an 'active' transition — both
// independent of anything CC's TUI happens to print. Before injecting, a baseline is captured for
// the target instance (max session_event id for that instance name, resolved primarily by NAME —
// the dispatch name — with `cwd` as a fallback match for a brand-new spawn whose instance row
// doesn't exist yet); after injecting, the poll below waits for EITHER a new session_event beyond
// that baseline OR a session for that instance becoming 'active'. The wrapper's own working-state
// signal (attachRegistry's isWorkingByName/isWorking — see outputScanner.ts) is kept as a
// SECONDARY OR'd signal — useful again once it tracks CC's current TUI (see outputScanner.ts's
// RUN_MARKER_PATTERNS), but no longer load-bearing on its own. It's still captured BEFORE
// injecting so an already-working target (skip the wait — it was busy, treat as delivered) is
// distinguished from a fresh transition to wait for.
import type Database from 'better-sqlite3';
import * as eventsRepo from '../db/repo/events.js';
import * as sessionsRepo from '../db/repo/sessions.js';
import type { HubConfig, IAttachRegistry, Logger } from '../types.js';
import type { TerminalSpawner } from './terminalSpawner.js';

export interface DispatchCandidate {
  name: string;
  cwd: string;
  attached: boolean;
  working: boolean;
}

export type DispatchAction =
  | { kind: 'inject'; name: string; cwd: string }
  | { kind: 'spawn'; name: string; cwd: string };

// Pure decision, no I/O: the first attached-and-idle candidate (in the given order — callers pass
// most-recently-active first) is reused via injection. An attached-but-working candidate is
// deliberately NOT interrupted — injecting mid-turn would land the task in the middle of the
// agent's own output, indistinguishable from corrupting its context — so a working candidate is
// skipped just like "no candidate" and a fresh tab is opened instead. No idle candidate anywhere
// -> spawn against the caller-supplied fallback cwd (the best-matching candidate's cwd, or
// whatever the caller passes when there were no candidates at all).
export function decideDispatch(
  candidates: DispatchCandidate[],
  requestedName: string,
  fallbackCwd: string
): DispatchAction {
  const idle = candidates.find((c) => c.attached && !c.working);
  if (idle) return { kind: 'inject', name: idle.name, cwd: idle.cwd };
  return { kind: 'spawn', name: requestedName, cwd: fallbackCwd };
}

export type DispatchVia = 'injected' | 'spawned' | 'spawned_no_inject' | 'failed';

export interface DispatchResult {
  ok: boolean;
  via: DispatchVia;
}

export interface DispatcherIo {
  // Injectable timer (fake timers in tests) — defaults to the real global setTimeout.
  setTimeoutFn?: typeof setTimeout;
}

export interface DispatcherDeps {
  attach: IAttachRegistry;
  spawner: TerminalSpawner;
  config: HubConfig;
  db: Database.Database;
  log: Logger;
  io?: DispatcherIo;
}

export interface Dispatcher {
  dispatch(action: DispatchAction, prompt: string): Promise<DispatchResult>;
}

// How often the spawn path polls for the new wrapper's registration + readiness, and how often
// verification below polls for the working-state transition.
const POLL_INTERVAL_MS = 500;

export function createDispatcher(deps: DispatcherDeps): Dispatcher {
  const { attach, spawner, config, db, log } = deps;
  const setTimeoutFn = deps.io?.setTimeoutFn ?? setTimeout;

  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeoutFn(resolve, ms));
  }

  function inject(name: string, cwd: string, prompt: string): boolean {
    return attach.injectByName ? attach.injectByName(name, prompt) : attach.inject(cwd, prompt);
  }

  function isRegistered(name: string, cwd: string): boolean {
    if (attach.getByName) return attach.getByName(name) !== undefined;
    return attach.get(cwd) !== undefined;
  }

  // Falls back to "ready" when the registry exposes no readiness signal at all (older/minimal
  // IAttachRegistry fakes) — mirrors isRegistered's own getByName->get(cwd) fallback style, and
  // keeps behavior unchanged for callers that predate this feature.
  function isReadyState(name: string, cwd: string): boolean {
    if (attach.isReadyByName) return attach.isReadyByName(name);
    if (attach.isReady) return attach.isReady(cwd);
    return true;
  }

  // Direct name-keyed lookup preferred, mirroring isReadyState's own getByName->get(cwd) style —
  // falls back to the cwd aggregate when the registry exposes no name-keyed signal at all (older/
  // minimal IAttachRegistry fakes).
  function isWorkingState(name: string, cwd: string): boolean {
    if (attach.isWorkingByName) return attach.isWorkingByName(name);
    return attach.isWorking(cwd);
  }

  // Hub-recorded activity for the target instance since a captured baseline — see file header.
  // `name` is checked first (the dispatch name matches session_events.instance_name exactly once
  // recorded), `cwd` is the fallback match for a brand-new spawn whose instance row doesn't exist
  // yet at baseline time. The working flag is kept as a secondary OR'd signal (useful again once
  // it tracks CC's current TUI — see outputScanner.ts).
  function hasNewActivity(name: string, cwd: string, eventBaselineId: number): boolean {
    return (
      eventsRepo.hasEventSince(db, name, eventBaselineId) ||
      sessionsRepo.hasActiveSessionForInstance(db, name, cwd) ||
      isWorkingState(name, cwd)
    );
  }

  // Polls every POLL_INTERVAL_MS (never checks instantly — the caller already captured the
  // pre-injection baseline for that) for up to timeoutMs for confirming activity to appear.
  async function pollForConfirmation(
    name: string,
    cwd: string,
    eventBaselineId: number,
    timeoutMs: number
  ): Promise<boolean> {
    let elapsed = 0;
    while (elapsed < timeoutMs) {
      await wait(POLL_INTERVAL_MS);
      elapsed += POLL_INTERVAL_MS;
      if (hasNewActivity(name, cwd, eventBaselineId)) return true;
    }
    return false;
  }

  // Confirms an injection actually landed via the hub's own session state instead of screen-
  // scraping (see file header). `wasWorkingBefore` must be captured BEFORE the injection that
  // preceded this call: if the target was already busy, that's treated as delivery straight away —
  // there's no fresh transition to wait for, and waiting for one would either time out pointlessly
  // or misattribute an unrelated turn's transition to this injection. Otherwise polls up to
  // confirmWorkingMs; on timeout, injects ONCE more and polls the same window again — total up to
  // 2 injections (the first already done by the caller).
  async function confirmDelivery(
    name: string,
    cwd: string,
    prompt: string,
    wasWorkingBefore: boolean,
    eventBaselineId: number
  ): Promise<boolean> {
    if (wasWorkingBefore) return true;
    const timeoutMs = config.terminalSpawn.confirmWorkingMs;
    if (await pollForConfirmation(name, cwd, eventBaselineId, timeoutMs)) return true;
    inject(name, cwd, prompt); // retry once; the poll below is authoritative either way
    return pollForConfirmation(name, cwd, eventBaselineId, timeoutMs);
  }

  async function dispatch(action: DispatchAction, prompt: string): Promise<DispatchResult> {
    try {
      if (action.kind === 'inject') {
        // Reusing an already-attached terminal: it's ready by definition (it's been running), so
        // there's no readiness wait. Capture the working state + session_events baseline BEFORE
        // injecting (see confirmDelivery) — an already-busy target is treated as delivered without
        // waiting for a transition that already happened. Never escalate a failed confirmation to
        // 'failed': the terminal is visible and usable either way, just logged for a human to check.
        const wasWorkingBefore = isWorkingState(action.name, action.cwd);
        const eventBaselineId = eventsRepo.maxIdForInstance(db, action.name);
        const ok = inject(action.name, action.cwd, prompt);
        if (!ok) return { ok: false, via: 'failed' };
        const confirmed = await confirmDelivery(action.name, action.cwd, prompt, wasWorkingBefore, eventBaselineId);
        if (!confirmed) {
          log.warn('dispatcher: injected prompt — working state never confirmed after retry', {
            name: action.name,
            cwd: action.cwd,
          });
        }
        return { ok: true, via: 'injected' };
      }

      const spawned = spawner.spawn({ cwd: action.cwd, name: action.name });
      if (!spawned) return { ok: false, via: 'failed' };

      const waitForRegisterMs = config.terminalSpawn.waitForRegisterMs;
      let ready = isRegistered(action.name, action.cwd) && isReadyState(action.name, action.cwd);
      let elapsed = 0;
      while (!ready && elapsed < waitForRegisterMs) {
        await wait(POLL_INTERVAL_MS);
        elapsed += POLL_INTERVAL_MS;
        ready = isRegistered(action.name, action.cwd) && isReadyState(action.name, action.cwd);
      }

      if (!ready) {
        log.warn('dispatcher: spawned tab did not become ready in time', {
          name: action.name,
          cwd: action.cwd,
          waitForRegisterMs,
        });
        return { ok: true, via: 'spawned_no_inject' };
      }

      const wasWorkingBefore = isWorkingState(action.name, action.cwd);
      const eventBaselineId = eventsRepo.maxIdForInstance(db, action.name);
      const ok = inject(action.name, action.cwd, prompt);
      if (!ok) return { ok: true, via: 'spawned_no_inject' };
      const confirmed = await confirmDelivery(action.name, action.cwd, prompt, wasWorkingBefore, eventBaselineId);
      if (!confirmed) {
        log.warn('dispatcher: spawned tab — working state never confirmed after retry', {
          name: action.name,
          cwd: action.cwd,
        });
        return { ok: true, via: 'spawned_no_inject' };
      }
      return { ok: true, via: 'spawned' };
    } catch (err) {
      log.warn('dispatcher: dispatch threw', { error: err instanceof Error ? err.message : String(err) });
      return { ok: false, via: 'failed' };
    }
  }

  return { dispatch };
}
