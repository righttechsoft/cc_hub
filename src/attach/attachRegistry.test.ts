import { describe, expect, it, vi, afterEach } from 'vitest';
import type { WSContext } from 'hono/ws';
import { AttachRegistry } from './attachRegistry.js';
import type { HubBus } from '../core/bus.js';
import type { AttachedClient, Logger } from '../types.js';

function silentLogger(): Logger & { warn: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> } {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// Structural stub matching HubBus's public surface — cast past the class's private `listeners`
// field, which makes it nominally (not just structurally) typed.
function fakeBus(): HubBus & { emit: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> } {
  return { emit: vi.fn(), on: vi.fn() } as unknown as HubBus & {
    emit: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  };
}

function fakeWs(): WSContext & { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  return { send: vi.fn(), close: vi.fn() } as unknown as WSContext & {
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
}

function fakeClient(ws: WSContext, overrides?: Partial<AttachedClient>): AttachedClient {
  return { ws, pid: 1234, lastSeen: Date.now(), ...overrides };
}

describe('AttachRegistry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('register then get returns the registered client', () => {
    const log = silentLogger();
    const bus = fakeBus();
    const registry = new AttachRegistry({ log, bus }, 30_000);
    const ws = fakeWs();
    const client = fakeClient(ws);

    registry.register('/proj', client);

    // The registry stores a copy (with the original cwd attached for event emission), so assert
    // on the meaningful contract — same ws reference and client fields — not object identity.
    const got = registry.get('/proj');
    expect(got?.ws).toBe(ws);
    expect(got).toMatchObject({ pid: client.pid, lastSeen: client.lastSeen });
    expect(registry.count()).toBe(1);
    expect(bus.emit).toHaveBeenCalledWith({ type: 'attach_status', cwd: '/proj', attached: true });
    registry.stop();
  });

  it('unregister removes the client when the ws matches', () => {
    const log = silentLogger();
    const bus = fakeBus();
    const registry = new AttachRegistry({ log, bus }, 30_000);
    const ws = fakeWs();
    registry.register('/proj', fakeClient(ws));

    registry.unregister('/proj', ws);

    expect(registry.get('/proj')).toBeUndefined();
    expect(bus.emit).toHaveBeenCalledWith({ type: 'attach_status', cwd: '/proj', attached: false });
    registry.stop();
  });

  it('unregister is a no-op when the ws does not match the stored client (stale close)', () => {
    const log = silentLogger();
    const bus = fakeBus();
    const registry = new AttachRegistry({ log, bus }, 30_000);
    const oldWs = fakeWs();
    const newWs = fakeWs();
    registry.register('/proj', fakeClient(oldWs));
    registry.register('/proj', fakeClient(newWs));

    registry.unregister('/proj', oldWs);

    expect(registry.get('/proj')?.ws).toBe(newWs);
    registry.stop();
  });

  it('inject returns false when no client is registered for the cwd', () => {
    const log = silentLogger();
    const bus = fakeBus();
    const registry = new AttachRegistry({ log, bus }, 30_000);

    expect(registry.inject('/nowhere', 'hi')).toBe(false);
    registry.stop();
  });

  it('inject returns true and sends the correct frame when a client is present', () => {
    const log = silentLogger();
    const bus = fakeBus();
    const registry = new AttachRegistry({ log, bus }, 30_000);
    const ws = fakeWs();
    registry.register('/proj', fakeClient(ws));

    const result = registry.inject('/proj', 'hello world');

    expect(result).toBe(true);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ t: 'inject', prompt: 'hello world', submit: true }));
    registry.stop();
  });

  it('inject returns false and logs debug when ws.send throws', () => {
    const log = silentLogger();
    const bus = fakeBus();
    const registry = new AttachRegistry({ log, bus }, 30_000);
    const ws = fakeWs();
    ws.send.mockImplementation(() => {
      throw new Error('socket closed');
    });
    registry.register('/proj', fakeClient(ws));

    const result = registry.inject('/proj', 'hello');

    expect(result).toBe(false);
    expect(log.debug).toHaveBeenCalled();
    registry.stop();
  });

  it('registering a different client for the same cwd displaces and closes the old one', () => {
    const log = silentLogger();
    const bus = fakeBus();
    const registry = new AttachRegistry({ log, bus }, 30_000);
    const oldWs = fakeWs();
    const newWs = fakeWs();
    registry.register('/proj', fakeClient(oldWs));

    registry.register('/proj', fakeClient(newWs));

    expect(registry.get('/proj')?.ws).toBe(newWs);
    expect(oldWs.close).toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
    // Displacing keeps the cwd attached — only the two attached:true emits, never attached:false.
    expect(bus.emit).not.toHaveBeenCalledWith({ type: 'attach_status', cwd: '/proj', attached: false });
    registry.stop();
  });

  it('sweep prunes clients stale beyond 2.5x heartbeatMs and closes their ws', () => {
    vi.useFakeTimers();
    const log = silentLogger();
    const bus = fakeBus();
    const heartbeatMs = 1000;
    const registry = new AttachRegistry({ log, bus }, heartbeatMs);
    const ws = fakeWs();
    registry.register('/proj', fakeClient(ws, { lastSeen: Date.now() }));

    // Advance past 2.5x heartbeatMs so the next sweep tick prunes the stale client.
    vi.advanceTimersByTime(heartbeatMs * 3);

    expect(registry.get('/proj')).toBeUndefined();
    expect(ws.close).toHaveBeenCalled();
    expect(bus.emit).toHaveBeenCalledWith({ type: 'attach_status', cwd: '/proj', attached: false });
    registry.stop();
  });

  it('ingestOutput appends to the ring, emits attach_output, and getRingB64 round-trips', () => {
    const log = silentLogger();
    const bus = fakeBus();
    const registry = new AttachRegistry({ log, bus }, 30_000);
    const ws = fakeWs();
    registry.register('/proj', fakeClient(ws));
    bus.emit.mockClear();

    const b64a = Buffer.from('hello ').toString('base64');
    const b64b = Buffer.from('world').toString('base64');
    registry.ingestOutput('/proj', b64a);
    registry.ingestOutput('/proj', b64b);

    expect(bus.emit).toHaveBeenNthCalledWith(1, { type: 'attach_output', cwd: '/proj', b64: b64a });
    expect(bus.emit).toHaveBeenNthCalledWith(2, { type: 'attach_output', cwd: '/proj', b64: b64b });
    expect(registry.getRingB64('/proj')).toBe(Buffer.from('hello world').toString('base64'));
    registry.stop();
  });

  it('ring trims to the last 65536 bytes on overflow', () => {
    const log = silentLogger();
    const bus = fakeBus();
    const registry = new AttachRegistry({ log, bus }, 30_000);
    const ws = fakeWs();
    registry.register('/proj', fakeClient(ws));

    const first = Buffer.alloc(60000, 'a');
    const second = Buffer.alloc(10000, 'b');
    registry.ingestOutput('/proj', first.toString('base64'));
    registry.ingestOutput('/proj', second.toString('base64'));

    const ring = Buffer.from(registry.getRingB64('/proj')!, 'base64');
    expect(ring.length).toBe(65536);
    // 60000 + 10000 = 70000 total, trimmed to the last 65536: 55536 'a's followed by 10000 'b's.
    expect(ring.subarray(0, 55536).every((b) => b === 'a'.charCodeAt(0))).toBe(true);
    expect(ring.subarray(55536).every((b) => b === 'b'.charCodeAt(0))).toBe(true);
    registry.stop();
  });

  it('ingestOutput on an unattached cwd is a no-op', () => {
    const log = silentLogger();
    const bus = fakeBus();
    const registry = new AttachRegistry({ log, bus }, 30_000);

    registry.ingestOutput('/nowhere', Buffer.from('x').toString('base64'));

    expect(registry.getRingB64('/nowhere')).toBeUndefined();
    expect(bus.emit).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'attach_output' }));
    registry.stop();
  });

  it('getRingB64 returns undefined for an empty or absent ring', () => {
    const log = silentLogger();
    const bus = fakeBus();
    const registry = new AttachRegistry({ log, bus }, 30_000);

    expect(registry.getRingB64('/proj')).toBeUndefined();
    registry.stop();
  });

  it('listAttached returns the currently-attached cwds', () => {
    const log = silentLogger();
    const bus = fakeBus();
    const registry = new AttachRegistry({ log, bus }, 30_000);
    registry.register('/proj-a', fakeClient(fakeWs()));
    registry.register('/proj-b', fakeClient(fakeWs()));

    expect(registry.listAttached().sort()).toEqual(['/proj-a', '/proj-b']);
    registry.stop();
  });

  it('isWorking defaults to false for a cwd that never reported', () => {
    const log = silentLogger();
    const bus = fakeBus();
    const registry = new AttachRegistry({ log, bus }, 30_000);

    expect(registry.isWorking('/proj')).toBe(false);
    registry.stop();
  });

  it('setWorking(true/false) round-trips through isWorking', () => {
    const log = silentLogger();
    const bus = fakeBus();
    const registry = new AttachRegistry({ log, bus }, 30_000);
    registry.register('/proj', fakeClient(fakeWs()));

    registry.setWorking('/proj', true);
    expect(registry.isWorking('/proj')).toBe(true);

    registry.setWorking('/proj', false);
    expect(registry.isWorking('/proj')).toBe(false);
    registry.stop();
  });

  it('isWorkingByName is the name-precise counterpart to isWorking(cwd) — set on one named sibling, false for another', () => {
    const log = silentLogger();
    const bus = fakeBus();
    const registry = new AttachRegistry({ log, bus }, 30_000);
    registry.register('/proj', fakeClient(fakeWs()), 'wb-sync');
    registry.register('/proj', fakeClient(fakeWs()), 'cd-new');

    registry.setWorking('/proj', true); // targets the most-recently-registered slot ('cd-new')

    expect(registry.isWorkingByName('cd-new')).toBe(true);
    expect(registry.isWorkingByName('wb-sync')).toBe(false);
    expect(registry.isWorkingByName('nobody')).toBe(false);
    registry.stop();
  });

  it('unregister clears the working flag along with the client', () => {
    const log = silentLogger();
    const bus = fakeBus();
    const registry = new AttachRegistry({ log, bus }, 30_000);
    const ws = fakeWs();
    registry.register('/proj', fakeClient(ws));
    registry.setWorking('/proj', true);

    registry.unregister('/proj', ws);

    expect(registry.isWorking('/proj')).toBe(false);
    registry.stop();
  });

  it('sweep pruning a stale client also clears its working flag', () => {
    vi.useFakeTimers();
    const log = silentLogger();
    const bus = fakeBus();
    const heartbeatMs = 1000;
    const registry = new AttachRegistry({ log, bus }, heartbeatMs);
    const ws = fakeWs();
    registry.register('/proj', fakeClient(ws, { lastSeen: Date.now() }));
    registry.setWorking('/proj', true);

    vi.advanceTimersByTime(heartbeatMs * 3);

    expect(registry.isWorking('/proj')).toBe(false);
    registry.stop();
  });

  // --- Named per-task agent identities: several clients can share one cwd ---

  it('named clients coexist in one cwd — registering a different name does NOT displace', () => {
    const log = silentLogger();
    const bus = fakeBus();
    const registry = new AttachRegistry({ log, bus }, 30_000);
    const wsA = fakeWs();
    const wsB = fakeWs();

    registry.register('/proj', fakeClient(wsA), 'wb-sync');
    registry.register('/proj', fakeClient(wsB), 'cd-new');

    expect(registry.getByName('wb-sync')?.ws).toBe(wsA);
    expect(registry.getByName('cd-new')?.ws).toBe(wsB);
    expect(wsA.close).not.toHaveBeenCalled();
    expect(wsB.close).not.toHaveBeenCalled();
    expect(registry.count()).toBe(2);
    registry.stop();
  });

  it('registering the same name again displaces only that name\'s client, not a sibling', () => {
    const log = silentLogger();
    const bus = fakeBus();
    const registry = new AttachRegistry({ log, bus }, 30_000);
    const wsA = fakeWs();
    const wsB = fakeWs();
    const wsA2 = fakeWs();

    registry.register('/proj', fakeClient(wsA), 'wb-sync');
    registry.register('/proj', fakeClient(wsB), 'cd-new');
    registry.register('/proj', fakeClient(wsA2), 'wb-sync');

    expect(wsA.close).toHaveBeenCalled();
    expect(wsB.close).not.toHaveBeenCalled();
    expect(registry.getByName('wb-sync')?.ws).toBe(wsA2);
    expect(registry.getByName('cd-new')?.ws).toBe(wsB);
    registry.stop();
  });

  it('injectByName sends to the exact named client, not a more-recently-registered sibling', () => {
    const log = silentLogger();
    const bus = fakeBus();
    const registry = new AttachRegistry({ log, bus }, 30_000);
    const wsA = fakeWs();
    const wsB = fakeWs();
    registry.register('/proj', fakeClient(wsA), 'wb-sync');
    registry.register('/proj', fakeClient(wsB), 'cd-new'); // registered later, same cwd

    const result = registry.injectByName('wb-sync', 'hello wb-sync');

    expect(result).toBe(true);
    expect(wsA.send).toHaveBeenCalledWith(JSON.stringify({ t: 'inject', prompt: 'hello wb-sync', submit: true }));
    expect(wsB.send).not.toHaveBeenCalled();
    registry.stop();
  });

  it('injectByName returns false for an unknown name without touching any client', () => {
    const log = silentLogger();
    const bus = fakeBus();
    const registry = new AttachRegistry({ log, bus }, 30_000);
    const ws = fakeWs();
    registry.register('/proj', fakeClient(ws), 'wb-sync');

    expect(registry.injectByName('nobody', 'hi')).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
    registry.stop();
  });

  it('cwd-keyed get/inject aggregate to the MOST RECENTLY REGISTERED client at that cwd', () => {
    const log = silentLogger();
    const bus = fakeBus();
    const registry = new AttachRegistry({ log, bus }, 30_000);
    const wsOld = fakeWs();
    const wsNew = fakeWs();
    registry.register('/proj', fakeClient(wsOld), 'wb-sync');
    registry.register('/proj', fakeClient(wsNew), 'cd-new');

    expect(registry.get('/proj')?.ws).toBe(wsNew);

    registry.inject('/proj', 'hi');
    expect(wsNew.send).toHaveBeenCalled();
    expect(wsOld.send).not.toHaveBeenCalled();
    registry.stop();
  });

  it('isWorking(cwd) sees a non-most-recently-registered client working (read-side OR, not "most recent")', () => {
    const log = silentLogger();
    const bus = fakeBus();
    const registry = new AttachRegistry({ log, bus }, 30_000);
    registry.register('/proj', fakeClient(fakeWs()), 'older'); // registered first -> "most recent" write targets this one below
    // setWorking(cwd) writes to the most-recently-registered slot, which at this point is 'older'.
    registry.setWorking('/proj', true);
    registry.register('/proj', fakeClient(fakeWs()), 'newer'); // now the most-recent slot for reads

    // isWorking(cwd) must still report true even though the WORKING flag lives on 'older', not
    // the now-most-recently-registered 'newer' slot — it's a genuine OR across the whole cwd.
    expect(registry.isWorking('/proj')).toBe(true);
    registry.stop();
  });

  it('rename re-keys a live client entry, its ring, and its working flag', () => {
    const log = silentLogger();
    const bus = fakeBus();
    const registry = new AttachRegistry({ log, bus }, 30_000);
    const ws = fakeWs();
    registry.register('/proj', fakeClient(ws), 'wb-sync');
    registry.setWorking('/proj', true);
    registry.ingestOutput('/proj', Buffer.from('hello').toString('base64'));

    registry.rename('wb-sync', 'wb-sync-2');

    expect(registry.getByName('wb-sync')).toBeUndefined();
    expect(registry.getByName('wb-sync-2')?.ws).toBe(ws);
    expect(registry.isWorking('/proj')).toBe(true); // working flag followed the rename
    expect(registry.getRingB64('/proj')).toBe(Buffer.from('hello').toString('base64')); // ring followed too
    registry.stop();
  });

  it('rename is a no-op when nothing is registered under the old name', () => {
    const log = silentLogger();
    const bus = fakeBus();
    const registry = new AttachRegistry({ log, bus }, 30_000);

    expect(() => registry.rename('nobody', 'someone')).not.toThrow();
    expect(registry.getByName('someone')).toBeUndefined();
    registry.stop();
  });

  it('unnamed register() still defaults to a pure cwd-derived key (existing behavior preserved)', () => {
    const log = silentLogger();
    const bus = fakeBus();
    const registry = new AttachRegistry({ log, bus }, 30_000);
    const ws = fakeWs();
    registry.register('/proj/wonkybox', fakeClient(ws));

    expect(registry.getByName('wonkybox')?.ws).toBe(ws);
    registry.stop();
  });

  // --- TUI readiness (see src/attach/outputScanner.ts's onReady) ---

  it('isReadyByName/isReady(cwd) default to false for a client that never reported ready', () => {
    const log = silentLogger();
    const bus = fakeBus();
    const registry = new AttachRegistry({ log, bus }, 30_000);
    registry.register('/proj', fakeClient(fakeWs()), 'wb-sync');

    expect(registry.isReadyByName('wb-sync')).toBe(false);
    expect(registry.isReady('/proj')).toBe(false);
    registry.stop();
  });

  it('setReady(cwd) marks the most-recently-registered client at that cwd ready', () => {
    const log = silentLogger();
    const bus = fakeBus();
    const registry = new AttachRegistry({ log, bus }, 30_000);
    registry.register('/proj', fakeClient(fakeWs()), 'wb-sync');

    registry.setReady('/proj');

    expect(registry.isReadyByName('wb-sync')).toBe(true);
    expect(registry.isReady('/proj')).toBe(true);
    registry.stop();
  });

  it('isReady(cwd) is a genuine OR across named siblings sharing a cwd, like isWorking', () => {
    const log = silentLogger();
    const bus = fakeBus();
    const registry = new AttachRegistry({ log, bus }, 30_000);
    registry.register('/proj', fakeClient(fakeWs()), 'older'); // "most recent" write target below
    registry.setReady('/proj'); // marks 'older' ready
    registry.register('/proj', fakeClient(fakeWs()), 'newer'); // now the most-recent slot

    // 'newer' never reported ready, but isReady(cwd) must still see 'older's readiness — OR, not
    // "most recent".
    expect(registry.isReadyByName('newer')).toBe(false);
    expect(registry.isReady('/proj')).toBe(true);
    registry.stop();
  });

  it('re-registering the same name resets readiness to false (a new wrapper/claude is booting)', () => {
    const log = silentLogger();
    const bus = fakeBus();
    const registry = new AttachRegistry({ log, bus }, 30_000);
    registry.register('/proj', fakeClient(fakeWs()), 'wb-sync');
    registry.setReady('/proj');
    expect(registry.isReadyByName('wb-sync')).toBe(true);

    registry.register('/proj', fakeClient(fakeWs()), 'wb-sync'); // displaced by a new wrapper

    expect(registry.isReadyByName('wb-sync')).toBe(false);
    registry.stop();
  });

  it('setReady(cwd) with no client registered there is a no-op', () => {
    const log = silentLogger();
    const bus = fakeBus();
    const registry = new AttachRegistry({ log, bus }, 30_000);

    expect(() => registry.setReady('/nowhere')).not.toThrow();
    expect(registry.isReady('/nowhere')).toBe(false);
    registry.stop();
  });

  it('unregister clears the ready flag along with the client', () => {
    const log = silentLogger();
    const bus = fakeBus();
    const registry = new AttachRegistry({ log, bus }, 30_000);
    const ws = fakeWs();
    registry.register('/proj', fakeClient(ws), 'wb-sync');
    registry.setReady('/proj');

    registry.unregister('/proj', ws);

    expect(registry.isReadyByName('wb-sync')).toBe(false);
    registry.stop();
  });

  it('rename carries the ready flag over to the new name', () => {
    const log = silentLogger();
    const bus = fakeBus();
    const registry = new AttachRegistry({ log, bus }, 30_000);
    registry.register('/proj', fakeClient(fakeWs()), 'wb-sync');
    registry.setReady('/proj');

    registry.rename('wb-sync', 'wb-sync-2');

    expect(registry.isReadyByName('wb-sync')).toBe(false);
    expect(registry.isReadyByName('wb-sync-2')).toBe(true);
    registry.stop();
  });
});
