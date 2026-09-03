import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSpawnArgs, createTerminalSpawner } from './terminalSpawner.js';
import type { HubConfig, Logger } from '../types.js';

function silentLogger(): Logger & { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> } {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function buildConfig(overrides: Partial<HubConfig['terminalSpawn']> = {}): HubConfig {
  return {
    terminalSpawn: {
      enabled: true,
      command: 'wt.exe',
      args: ['-w', '0', 'new-tab', '--title', '{title}', '--startingDirectory', '{cwd}', 'cmd', '/k', '{launcher}', '--name', '{name}'],
      maxPerHour: 6,
      waitForRegisterMs: 60_000,
      ...overrides,
    },
    // Only `terminalSpawn` above is actually read by createTerminalSpawner — the rest of
    // HubConfig is irrelevant to this module, hence the cast rather than a full fixture.
  } as unknown as HubConfig;
}

// Fake spawnFn — a test must never let a real process get launched. Returns a minimal stub with
// an `unref` the spawner calls unconditionally.
function fakeSpawnFn() {
  const calls: { command: string; args: string[]; options: unknown }[] = [];
  const fn = vi.fn((command: string, args: string[], options: unknown) => {
    calls.push({ command, args, options });
    return { unref: vi.fn() };
  });
  return { fn, calls };
}

describe('buildSpawnArgs', () => {
  it('substitutes placeholders per element', () => {
    const result = buildSpawnArgs(['--title', '{title}', '--dir', '{cwd}'], { title: 'wb-sync', cwd: 'C:\\proj' });
    expect(result).toEqual(['--title', 'wb-sync', '--dir', 'C:\\proj']);
  });

  it('substitutes a placeholder embedded within a larger element', () => {
    const result = buildSpawnArgs(['--dir={cwd}'], { cwd: 'C:\\proj' });
    expect(result).toEqual(['--dir=C:\\proj']);
  });

  it('leaves unknown placeholders untouched', () => {
    const result = buildSpawnArgs(['{unknown}', 'literal'], { cwd: 'C:\\proj' });
    expect(result).toEqual(['{unknown}', 'literal']);
  });

  it('substitutes multiple distinct placeholders in one element', () => {
    const result = buildSpawnArgs(['{launcher} --name {name}'], { launcher: 'cc-attach.cmd', name: 'wb-sync' });
    expect(result).toEqual(['cc-attach.cmd --name wb-sync']);
  });

  it('does not mutate the input template array', () => {
    const template = ['{cwd}'];
    const copy = [...template];
    buildSpawnArgs(template, { cwd: 'C:\\proj' });
    expect(template).toEqual(copy);
  });
});

describe('createTerminalSpawner guards', () => {
  let dir: string;

  function makeDir(): string {
    dir = mkdtempSync(join(tmpdir(), 'cc-hub-spawn-'));
    return dir;
  }

  function cleanup(): void {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }

  it('refuses to spawn when disabled in config', () => {
    const cwd = makeDir();
    try {
      const log = silentLogger();
      const { fn } = fakeSpawnFn();
      const spawner = createTerminalSpawner({ config: buildConfig({ enabled: false }), log, spawnFn: fn });
      expect(spawner.spawn({ cwd, name: 'wb-sync' })).toBe(false);
      expect(fn).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('refuses to spawn on a non-win32 platform', () => {
    const cwd = makeDir();
    const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const log = silentLogger();
      const { fn } = fakeSpawnFn();
      const spawner = createTerminalSpawner({ config: buildConfig(), log, spawnFn: fn });
      expect(spawner.spawn({ cwd, name: 'wb-sync' })).toBe(false);
      expect(fn).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', originalDescriptor);
      cleanup();
    }
  });

  it('refuses to spawn with an invalid name', () => {
    const cwd = makeDir();
    try {
      const log = silentLogger();
      const { fn } = fakeSpawnFn();
      const spawner = createTerminalSpawner({ config: buildConfig(), log, spawnFn: fn });
      expect(spawner.spawn({ cwd, name: 'Not Valid!' })).toBe(false);
      expect(fn).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('refuses to spawn when cwd does not exist', () => {
    const log = silentLogger();
    const { fn } = fakeSpawnFn();
    const spawner = createTerminalSpawner({ config: buildConfig(), log, spawnFn: fn });
    expect(spawner.spawn({ cwd: join(tmpdir(), 'cc-hub-does-not-exist-xyz'), name: 'wb-sync' })).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('refuses to spawn when cwd is not a directory', () => {
    const dirPath = makeDir();
    const filePath = join(dirPath, 'file.txt');
    writeFileSync(filePath, 'x');
    try {
      const log = silentLogger();
      const { fn } = fakeSpawnFn();
      const spawner = createTerminalSpawner({ config: buildConfig(), log, spawnFn: fn });
      expect(spawner.spawn({ cwd: filePath, name: 'wb-sync' })).toBe(false);
      expect(fn).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('refuses to spawn once the hourly cap is reached', () => {
    const cwd = makeDir();
    try {
      const log = silentLogger();
      const { fn } = fakeSpawnFn();
      const spawner = createTerminalSpawner({ config: buildConfig({ maxPerHour: 2 }), log, spawnFn: fn });
      expect(spawner.spawn({ cwd, name: 'wb-sync' })).toBe(true);
      expect(spawner.spawn({ cwd, name: 'wb-sync' })).toBe(true);
      expect(spawner.spawn({ cwd, name: 'wb-sync' })).toBe(false);
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      cleanup();
    }
  });

  it('spawns with shell:false, detached, and the templated args', () => {
    const cwd = makeDir();
    try {
      const log = silentLogger();
      const { fn, calls } = fakeSpawnFn();
      const spawner = createTerminalSpawner({ config: buildConfig(), log, spawnFn: fn });
      expect(spawner.spawn({ cwd, name: 'wb-sync' })).toBe(true);
      expect(calls.length).toBe(1);
      expect(calls[0].command).toBe('wt.exe');
      expect(calls[0].args).toContain('wb-sync');
      expect(calls[0].options).toMatchObject({ cwd, detached: true, stdio: 'ignore', shell: false });
    } finally {
      cleanup();
    }
  });

  it('returns false and does not spawn when spawnFn throws', () => {
    const cwd = makeDir();
    try {
      const log = silentLogger();
      const throwing = vi.fn((): never => {
        throw new Error('boom');
      });
      const spawner = createTerminalSpawner({ config: buildConfig(), log, spawnFn: throwing });
      expect(spawner.spawn({ cwd, name: 'wb-sync' })).toBe(false);
    } finally {
      cleanup();
    }
  });
});
