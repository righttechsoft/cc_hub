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

    expect(registry.get('/proj')).toBe(client);
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
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ t: 'inject', prompt: 'hello world' }));
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
});
