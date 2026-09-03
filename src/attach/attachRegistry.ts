// Hub-side registry of attached `cc-attach` wrapper terminals. Historically one wrapper per
// project cwd (matching the identity-by-cwd model — see src/core/identity.ts); named per-task
// agent identities (cc-attach --name / CC_HUB_NAME / hub_register name) allow several wrappers to
// share one cwd, so clients are keyed by resolved INSTANCE NAME internally. PromptDelivery and
// chatDelivery consult this before falling back to a headless spawn: if a wrapper is attached for
// the target cwd/name, prompts are injected into the real interactive terminal instead. Liveness
// mirrors src/relay/relayClient.ts's reconnect-and-resweep shape, just for inbound clients
// instead of one outbound tunnel.
//
// cwd-keyed API (get/inject/touch/ingestOutput/getRingB64/setWorking) predates named identities
// and stays for backward compatibility with callers that only have a cwd (promptDelivery/
// chatDelivery when no instance name is cheaply available, wsHub's attach_subscribe, the admin
// sessions-list). When several named clients share a cwd, these aggregate: get/inject/touch/
// ingestOutput/getRingB64/setWorking all resolve to the MOST RECENTLY REGISTERED client for that
// cwd (a documented limitation — see CLAUDE.md); isWorking is the one exception and is a genuine
// OR across every client at the cwd, matching its "is ANYONE in this folder working" read.
// Callers that already know the target's resolved name (promptDelivery via
// session.instance_name, chatDelivery via the instance row) should prefer `injectByName` so mail
// for "wb-sync" lands in wb-sync's terminal specifically, not whichever wrapper registered last.
import type { WSContext } from 'hono/ws';
import type { AttachedClient, IAttachRegistry, Logger } from '../types.js';
import type { HubBus } from '../core/bus.js';

// Stale-client sweep window: a client that hasn't pinged in this many heartbeats is assumed
// gone (half-open TCP after e.g. a wrapper crash or a machine sleep) and pruned.
const STALE_MULTIPLIER = 2.5;

// Per-client pty output ring buffer size — mirrors the wrapper's coalescing window; big enough to
// give a freshly-subscribed mobile client a useful screen's worth of scrollback without holding
// unbounded memory per attached instance.
const RING_MAX_BYTES = 65536;

// Close code sent to a wrapper displaced by a newer registration for the same NAME. The wrapper
// recognizes it and goes dormant (slow retry) instead of immediately reconnecting — otherwise two
// unnamed terminals in one directory (which resolve to the same default name) displace each other
// in an endless ping-pong, each cycle spamming both the hub log and the wrappers' outage handling.
export const CLOSE_DISPLACED = 4001;

// Registry entries carry the cwd exactly as the wrapper registered it, so bus events and
// listAttached() keep the original casing (sessions record the same casing — the wrapper and the
// claude it spawns share one process cwd). cwd-keyed lookups case-normalize on Windows, where
// paths differing in case are the same directory.
interface Slot extends AttachedClient {
  cwd: string;
  name: string;
  registeredAt: number;
}

function cwdKeyOf(cwd: string): string {
  return process.platform === 'win32' ? cwd.toLowerCase() : cwd;
}

function nameKeyOf(name: string): string {
  return name.toLowerCase();
}

// Pure, DB-independent default name for a cwd with no explicit --name — deliberately NOT the
// same (collision-aware, DB-backed) derivation as core/identity.ts's instanceNameFromCwd: this is
// only an in-memory map key so two unnamed wrappers in the same folder keep displacing each other
// exactly as before. The DB-durable identity a caller actually cares about (for injectByName,
// message routing, etc.) always comes from instancesRepo, independent of this key.
function defaultNameForCwd(cwd: string): string {
  const norm = cwd.replace(/[\\/]+$/, '');
  const base = norm.split(/[\\/]/).pop() || norm;
  return base.toLowerCase();
}

export interface AttachRegistryDeps {
  log: Logger;
  bus: HubBus;
}

export class AttachRegistry implements IAttachRegistry {
  private readonly log: Logger;
  private readonly bus: HubBus;
  private readonly heartbeatMs: number;
  // Keyed by nameKeyOf(resolved name) — see file header.
  private readonly clients = new Map<string, Slot>();
  private readonly rings = new Map<string, Buffer>();
  private readonly working = new Map<string, boolean>();
  // TUI-ready flag per client (see src/attach/outputScanner.ts) — true once the wrapper reports
  // {t:'ready'}. Absent/false by default; reset on re-register since a new wrapper/claude process
  // is booting from scratch under that name.
  private readonly ready = new Map<string, boolean>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor(deps: AttachRegistryDeps, heartbeatMs: number) {
    this.log = deps.log;
    this.bus = deps.bus;
    this.heartbeatMs = heartbeatMs;
    this.sweepTimer = setInterval(() => this.sweep(), heartbeatMs);
    this.sweepTimer.unref();
  }

  // `name`, when supplied, should already be the fully-resolved instance name (post collision
  // disambiguation) — see app.ts's /attach register handler. Omitted -> a pure cwd-derived
  // default key (see defaultNameForCwd), preserving pre-named-identity displacement behavior for
  // the common (no --name) case.
  register(cwd: string, client: AttachedClient, name?: string): void {
    const resolvedName = name ?? defaultNameForCwd(cwd);
    const key = nameKeyOf(resolvedName);
    const existing = this.clients.get(key);
    if (existing && existing.ws !== client.ws) {
      this.log.warn('attachRegistry: displacing existing client for name', { name: resolvedName, cwd });
      this.closeQuietly(existing.ws, CLOSE_DISPLACED, 'displaced');
    }
    this.clients.set(key, { ...client, cwd, name: resolvedName, registeredAt: Date.now() });
    // A new wrapper/claude process is booting under this name — any prior readiness (from a
    // displaced client, or a stale entry a sweep hadn't yet cleared) no longer applies.
    this.ready.delete(key);
    this.bus.emit({ type: 'attach_status', cwd, attached: true });
  }

  unregister(cwd: string, ws: WSContext): void {
    for (const [key, slot] of this.clients) {
      // Only remove if this ws is still the one on file — a stale close from an already-displaced
      // client must not delete a newer registration that has since taken its place.
      if (slot.ws !== ws) continue;
      this.clients.delete(key);
      this.rings.delete(key);
      this.working.delete(key);
      this.ready.delete(key);
      this.bus.emit({ type: 'attach_status', cwd: slot.cwd, attached: false });
      return;
    }
  }

  // Most recently registered CURRENTLY CONNECTED client at this cwd, or undefined. Backs every
  // cwd-keyed method except isWorking (see file header). `>=` (not `>`): registeredAt is a
  // Date.now() millisecond timestamp, and two registrations in the same tick/millisecond are
  // common (a script attaching several wrappers back-to-back); Map iteration order is insertion
  // order, so on a tie this still correctly prefers the LATER registration.
  private mostRecentSlotForCwd(cwd: string): Slot | undefined {
    const key = cwdKeyOf(cwd);
    let best: Slot | undefined;
    for (const slot of this.clients.values()) {
      if (cwdKeyOf(slot.cwd) !== key) continue;
      if (!best || slot.registeredAt >= best.registeredAt) best = slot;
    }
    return best;
  }

  get(cwd: string): AttachedClient | undefined {
    return this.mostRecentSlotForCwd(cwd);
  }

  getByName(name: string): AttachedClient | undefined {
    return this.clients.get(nameKeyOf(name));
  }

  inject(cwd: string, prompt: string, submit?: boolean): boolean {
    const client = this.mostRecentSlotForCwd(cwd);
    if (!client) return false;
    return this.sendInject(client, prompt, submit, cwd);
  }

  // Direct name-keyed injection — the preferred path whenever the caller already knows the
  // resolved instance name (see file header), so mail for "wb-sync" lands in wb-sync's terminal
  // specifically even if a different, more-recently-registered wrapper shares its cwd.
  injectByName(name: string, prompt: string, submit?: boolean): boolean {
    const client = this.clients.get(nameKeyOf(name));
    if (!client) return false;
    return this.sendInject(client, prompt, submit, client.cwd);
  }

  private sendInject(client: Slot, prompt: string, submit: boolean | undefined, cwdForLog: string): boolean {
    try {
      client.ws.send(JSON.stringify({ t: 'inject', prompt, submit: submit ?? true }));
      return true;
    } catch (err) {
      this.log.debug('attachRegistry: inject failed', {
        cwd: cwdForLog,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  touch(cwd: string, ws: WSContext): void {
    for (const slot of this.clients.values()) {
      if (slot.ws === ws) {
        slot.lastSeen = Date.now();
        return;
      }
    }
  }

  count(): number {
    return this.clients.size;
  }

  // Appends decoded pty output to the ring of the most-recently-registered client at this cwd
  // (trimmed to the last RING_MAX_BYTES) and re-emits the same incremental b64 on the bus for
  // live subscribers. A no-op for a cwd with no currently-attached client (e.g. a straggling
  // frame that arrives after unregister/prune).
  ingestOutput(cwd: string, b64: string): void {
    const slot = this.mostRecentSlotForCwd(cwd);
    if (!slot) return;
    const key = nameKeyOf(slot.name);
    const chunk = Buffer.from(b64, 'base64');
    const prior = this.rings.get(key);
    let ring = prior ? Buffer.concat([prior, chunk]) : chunk;
    if (ring.length > RING_MAX_BYTES) ring = ring.subarray(ring.length - RING_MAX_BYTES);
    this.rings.set(key, ring);
    this.bus.emit({ type: 'attach_output', cwd: slot.cwd, b64 });
  }

  getRingB64(cwd: string): string | undefined {
    const slot = this.mostRecentSlotForCwd(cwd);
    if (!slot) return undefined;
    const ring = this.rings.get(nameKeyOf(slot.name));
    if (!ring || ring.length === 0) return undefined;
    return ring.toString('base64');
  }

  listAttached(): string[] {
    return [...new Set([...this.clients.values()].map((s) => s.cwd))];
  }

  // Write path: ambiguous when several named clients share a cwd, so (like the other cwd-keyed
  // writes above) this targets the most-recently-registered one. isWorking below is the read-side
  // aggregate and is intentionally NOT "most recent" — see file header.
  setWorking(cwd: string, on: boolean): void {
    const slot = this.mostRecentSlotForCwd(cwd);
    if (!slot) return;
    const key = nameKeyOf(slot.name);
    if (on) this.working.set(key, true);
    else this.working.delete(key);
  }

  isWorking(cwd: string): boolean {
    const key = cwdKeyOf(cwd);
    for (const slot of this.clients.values()) {
      if (cwdKeyOf(slot.cwd) === key && this.working.get(nameKeyOf(slot.name)) === true) return true;
    }
    return false;
  }

  // Direct name-keyed working-state lookup — the precise counterpart to isWorking(cwd)'s aggregate,
  // used by src/spawn/dispatcher.ts to confirm an injected prompt landed (see CLAUDE.md's dispatch
  // gotcha: pasted text never appears as contiguous bytes in ConPTY's diff-repainted output, so the
  // dispatcher polls this instead of screen-scraping the output ring).
  isWorkingByName(name: string): boolean {
    return this.working.get(nameKeyOf(name)) === true;
  }

  // TUI-ready write (see src/attach/outputScanner.ts's onReady) — same write-target semantics as
  // setWorking above (most-recently-registered client at this cwd). Unlike working, there is no
  // "off" case: the wrapper only ever sends {t:'ready'} once, and readiness is reset by `register`
  // (a new wrapper/claude booting), not by an explicit off signal.
  setReady(cwd: string): void {
    const slot = this.mostRecentSlotForCwd(cwd);
    if (!slot) return;
    this.ready.set(nameKeyOf(slot.name), true);
  }

  // Direct name-keyed readiness lookup — the precise counterpart to isWorking(cwd)'s aggregate,
  // used by src/spawn/dispatcher.ts once it already knows the resolved name (a freshly spawned tab
  // always registers under a specific requested name).
  isReadyByName(name: string): boolean {
    return this.ready.get(nameKeyOf(name)) === true;
  }

  // Read-side aggregate — genuine OR across every client at the cwd, matching isWorking(cwd)'s
  // semantics (not "most recent").
  isReady(cwd: string): boolean {
    const key = cwdKeyOf(cwd);
    for (const slot of this.clients.values()) {
      if (cwdKeyOf(slot.cwd) === key && this.ready.get(nameKeyOf(slot.name)) === true) return true;
    }
    return false;
  }

  // Admin-page rename (running instances, no restart required): re-keys the live client entry
  // (and its ring/working state) if one is currently registered under `oldName`. A no-op
  // otherwise — the terminal's own CC_HUB_NAME env only takes effect on relaunch, so an attached
  // wrapper for a just-renamed instance may not exist yet under either name.
  rename(oldName: string, newName: string): void {
    const oldKey = nameKeyOf(oldName);
    const newKey = nameKeyOf(newName);
    const slot = this.clients.get(oldKey);
    if (!slot) return;

    this.clients.delete(oldKey);
    this.clients.set(newKey, { ...slot, name: newName });

    const ring = this.rings.get(oldKey);
    if (ring !== undefined) {
      this.rings.delete(oldKey);
      this.rings.set(newKey, ring);
    }

    const working = this.working.get(oldKey);
    if (working !== undefined) {
      this.working.delete(oldKey);
      this.working.set(newKey, working);
    }

    const ready = this.ready.get(oldKey);
    if (ready !== undefined) {
      this.ready.delete(oldKey);
      this.ready.set(newKey, ready);
    }
  }

  stop(): void {
    clearInterval(this.sweepTimer);
  }

  private sweep(): void {
    const staleAfterMs = this.heartbeatMs * STALE_MULTIPLIER;
    const now = Date.now();
    for (const [key, client] of this.clients) {
      if (now - client.lastSeen > staleAfterMs) {
        this.log.warn('attachRegistry: pruning stale client', { cwd: client.cwd, name: client.name });
        this.closeQuietly(client.ws);
        this.clients.delete(key);
        this.rings.delete(key);
        this.working.delete(key);
        this.ready.delete(key);
        this.bus.emit({ type: 'attach_status', cwd: client.cwd, attached: false });
      }
    }
  }

  private closeQuietly(ws: WSContext, code?: number, reason?: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // ignore — socket may already be closing
    }
  }
}
