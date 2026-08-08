// Hub-side registry of attached `cc-attach` wrapper terminals, keyed by project cwd (matches
// the identity-by-cwd model — see src/core/identity.ts). PromptDelivery and chatDelivery
// consult this before falling back to a headless spawn: if a wrapper is attached for the
// target cwd, prompts are injected into the real interactive terminal instead. Liveness
// mirrors src/relay/relayClient.ts's reconnect-and-resweep shape, just for inbound clients
// instead of one outbound tunnel.
import type { WSContext } from 'hono/ws';
import type { AttachedClient, IAttachRegistry, Logger } from '../types.js';
import type { HubBus } from '../core/bus.js';

// Stale-client sweep window: a client that hasn't pinged in this many heartbeats is assumed
// gone (half-open TCP after e.g. a wrapper crash or a machine sleep) and pruned.
const STALE_MULTIPLIER = 2.5;

// Per-cwd pty output ring buffer size — mirrors the wrapper's coalescing window; big enough to
// give a freshly-subscribed mobile client a useful screen's worth of scrollback without holding
// unbounded memory per attached instance.
const RING_MAX_BYTES = 65536;

// Close code sent to a wrapper displaced by a newer registration for the same cwd. The wrapper
// recognizes it and goes dormant (slow retry) instead of immediately reconnecting — otherwise two
// terminals in one directory displace each other in an endless ping-pong, each cycle spamming
// both the hub log and the wrappers' outage handling.
export const CLOSE_DISPLACED = 4001;

// Registry entries carry the cwd exactly as the wrapper registered it, so bus events and
// listAttached() keep the original casing (sessions record the same casing — the wrapper and the
// claude it spawns share one process cwd). Only the MAP KEY is case-normalized on Windows, where
// paths differing in case are the same directory (two terminals launched via differently-cased
// paths must share one slot, not silently hold two).
interface Slot extends AttachedClient {
  cwd: string;
}

function keyOf(cwd: string): string {
  return process.platform === 'win32' ? cwd.toLowerCase() : cwd;
}

export interface AttachRegistryDeps {
  log: Logger;
  bus: HubBus;
}

export class AttachRegistry implements IAttachRegistry {
  private readonly log: Logger;
  private readonly bus: HubBus;
  private readonly heartbeatMs: number;
  private readonly clients = new Map<string, Slot>();
  private readonly rings = new Map<string, Buffer>();
  private readonly working = new Map<string, boolean>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor(deps: AttachRegistryDeps, heartbeatMs: number) {
    this.log = deps.log;
    this.bus = deps.bus;
    this.heartbeatMs = heartbeatMs;
    this.sweepTimer = setInterval(() => this.sweep(), heartbeatMs);
    this.sweepTimer.unref();
  }

  register(cwd: string, client: AttachedClient): void {
    const key = keyOf(cwd);
    const existing = this.clients.get(key);
    if (existing && existing.ws !== client.ws) {
      this.log.warn('attachRegistry: displacing existing client for cwd', { cwd });
      this.closeQuietly(existing.ws, CLOSE_DISPLACED, 'displaced');
    }
    this.clients.set(key, { ...client, cwd });
    this.bus.emit({ type: 'attach_status', cwd, attached: true });
  }

  unregister(cwd: string, ws: WSContext): void {
    const key = keyOf(cwd);
    const existing = this.clients.get(key);
    // Only remove if this ws is still the one on file — a stale close from an already-displaced
    // client must not delete a newer registration that has since taken its place.
    if (existing && existing.ws === ws) {
      this.clients.delete(key);
      this.rings.delete(key);
      this.working.delete(key);
      this.bus.emit({ type: 'attach_status', cwd: existing.cwd, attached: false });
    }
  }

  get(cwd: string): AttachedClient | undefined {
    return this.clients.get(keyOf(cwd));
  }

  inject(cwd: string, prompt: string, submit?: boolean): boolean {
    const client = this.clients.get(keyOf(cwd));
    if (!client) return false;
    try {
      client.ws.send(JSON.stringify({ t: 'inject', prompt, submit: submit ?? true }));
      return true;
    } catch (err) {
      this.log.debug('attachRegistry: inject failed', {
        cwd,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  touch(cwd: string, ws: WSContext): void {
    const existing = this.clients.get(keyOf(cwd));
    if (existing && existing.ws === ws) {
      existing.lastSeen = Date.now();
    }
  }

  count(): number {
    return this.clients.size;
  }

  // Appends decoded pty output to the cwd's ring (trimmed to the last RING_MAX_BYTES) and
  // re-emits the same incremental b64 on the bus for live subscribers. A no-op for a cwd that
  // isn't currently attached (e.g. a straggling frame that arrives after unregister/prune).
  ingestOutput(cwd: string, b64: string): void {
    const key = keyOf(cwd);
    const slot = this.clients.get(key);
    if (!slot) return;
    const chunk = Buffer.from(b64, 'base64');
    const prior = this.rings.get(key);
    let ring = prior ? Buffer.concat([prior, chunk]) : chunk;
    if (ring.length > RING_MAX_BYTES) ring = ring.subarray(ring.length - RING_MAX_BYTES);
    this.rings.set(key, ring);
    this.bus.emit({ type: 'attach_output', cwd: slot.cwd, b64 });
  }

  getRingB64(cwd: string): string | undefined {
    const ring = this.rings.get(keyOf(cwd));
    if (!ring || ring.length === 0) return undefined;
    return ring.toString('base64');
  }

  listAttached(): string[] {
    return [...this.clients.values()].map((s) => s.cwd);
  }

  setWorking(cwd: string, on: boolean): void {
    if (on) this.working.set(keyOf(cwd), true);
    else this.working.delete(keyOf(cwd));
  }

  isWorking(cwd: string): boolean {
    return this.working.get(keyOf(cwd)) === true;
  }

  stop(): void {
    clearInterval(this.sweepTimer);
  }

  private sweep(): void {
    const staleAfterMs = this.heartbeatMs * STALE_MULTIPLIER;
    const now = Date.now();
    for (const [key, client] of this.clients) {
      if (now - client.lastSeen > staleAfterMs) {
        this.log.warn('attachRegistry: pruning stale client', { cwd: client.cwd });
        this.closeQuietly(client.ws);
        this.clients.delete(key);
        this.rings.delete(key);
        this.working.delete(key);
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
