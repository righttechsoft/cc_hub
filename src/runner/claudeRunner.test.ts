import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Logger } from '../types.js';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const { ClaudeRunner } = await import('./claudeRunner.js');

function fakeChild(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> } {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

function silentLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

describe('ClaudeRunner', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('startNew omits --resume; resumePrompt still includes it', async () => {
    spawnMock.mockImplementation(() => {
      const child = fakeChild();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });

    const runner = new ClaudeRunner('claude.exe', 4, silentLogger());

    await runner.startNew({ cwd: '/proj', prompt: 'hi' });
    await runner.resumePrompt({ sessionId: 'sess-1', cwd: '/proj', prompt: 'hi' });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    const [, newArgs] = spawnMock.mock.calls[0] as [string, string[]];
    const [, resumeArgs] = spawnMock.mock.calls[1] as [string, string[]];

    expect(newArgs).toEqual(['-p', 'hi', '--output-format', 'json']);
    expect(resumeArgs).toEqual(['--resume', 'sess-1', '-p', 'hi', '--output-format', 'json']);
  });
});
