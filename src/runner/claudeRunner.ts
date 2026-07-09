import { spawn } from 'node:child_process';
import type { IClaudeRunner, Logger, RunResult } from '../types.js';

const MAX_BUFFER_CHARS = 256 * 1024;
const KILL_TIMEOUT_MS = 30 * 60 * 1000;

interface RunningEntry {
  cwd: string;
}

/** Direct-spawns claude.exe --resume for headless turn delivery. One child per session, capped globally by maxConcurrent. */
export class ClaudeRunner implements IClaudeRunner {
  private readonly running = new Map<string, RunningEntry>();
  private newSessionCounter = 0;

  constructor(
    private readonly claudePath: string,
    private readonly maxConcurrent: number,
    private readonly log: Logger,
  ) {}

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  /** Any running child whose cwd matches — used by hooksRoutes for the resumed_from heuristic. */
  runningCwd(cwd: string): boolean {
    for (const entry of this.running.values()) {
      if (entry.cwd === cwd) return true;
    }
    return false;
  }

  atCapacity(): boolean {
    return this.running.size >= this.maxConcurrent;
  }

  async resumePrompt(opts: {
    sessionId: string;
    cwd: string;
    prompt: string;
    permissionMode?: string;
  }): Promise<RunResult> {
    const { sessionId, cwd, prompt, permissionMode } = opts;

    if (this.isRunning(sessionId)) {
      throw new Error(`ClaudeRunner: session ${sessionId} is already running`);
    }
    if (this.atCapacity()) {
      throw new Error(
        `ClaudeRunner: max concurrent runs (${this.maxConcurrent}) reached, cannot start session ${sessionId}`,
      );
    }

    const args = [
      '--resume',
      sessionId,
      '-p',
      prompt,
      '--output-format',
      'json',
      ...(permissionMode ? ['--permission-mode', permissionMode] : []),
    ];

    this.running.set(sessionId, { cwd });

    try {
      return await this.spawnAndWait(sessionId, cwd, args);
    } finally {
      this.running.delete(sessionId);
    }
  }

  async startNew(opts: { cwd: string; prompt: string; permissionMode?: string }): Promise<RunResult> {
    const { cwd, prompt, permissionMode } = opts;

    if (this.atCapacity()) {
      throw new Error(`ClaudeRunner: max concurrent runs (${this.maxConcurrent}) reached, cannot start new session`);
    }

    const args = [
      '-p',
      prompt,
      '--output-format',
      'json',
      ...(permissionMode ? ['--permission-mode', permissionMode] : []),
    ];

    const key = `new:${++this.newSessionCounter}`;
    this.running.set(key, { cwd });

    try {
      return await this.spawnAndWait(key, cwd, args);
    } finally {
      this.running.delete(key);
    }
  }

  private spawnAndWait(key: string, cwd: string, args: string[]): Promise<RunResult> {
    const startedAt = Date.now();

    return new Promise<RunResult>((resolve) => {
      let child;
      try {
        child = spawn(this.claudePath, args, {
          cwd,
          windowsHide: true,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        resolve({
          code: null,
          stdout: '',
          stderr: err instanceof Error ? err.message : String(err),
          startedAt,
          endedAt: Date.now(),
        });
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;

      const killTimer = setTimeout(() => {
        this.log.warn(`ClaudeRunner: session ${key} exceeded 30min, killing`);
        child.kill();
      }, KILL_TIMEOUT_MS);

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length >= MAX_BUFFER_CHARS) return;
        stdout += chunk.toString('utf8');
        if (stdout.length > MAX_BUFFER_CHARS) stdout = stdout.slice(0, MAX_BUFFER_CHARS);
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length >= MAX_BUFFER_CHARS) return;
        stderr += chunk.toString('utf8');
        if (stderr.length > MAX_BUFFER_CHARS) stderr = stderr.slice(0, MAX_BUFFER_CHARS);
      });

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve({
          code: null,
          stdout: '',
          stderr: err.message,
          startedAt,
          endedAt: Date.now(),
        });
      });

      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve({ code, stdout, stderr, startedAt, endedAt: Date.now() });
      });
    });
  }
}
