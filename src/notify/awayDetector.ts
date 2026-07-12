import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { HubConfig, Logger } from '../types.js';

export interface AwayDetectorDeps {
  config: HubConfig;
  log: Logger;
}

export interface AwayDetector {
  isAway(): boolean;
  idleMs(): number | null;
  stop(): void;
}

interface Sample {
  idleMs: number;
  receivedAt: number;
}

const STALE_SAMPLE_MS = 60_000;
const RESPAWN_DELAY_MS = 30_000;
const POLL_SCRIPT = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class UserIdle {
  [StructLayout(LayoutKind.Sequential)] private struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] private static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  public static uint GetIdleMs() {
    var lii = new LASTINPUTINFO(); lii.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
    if (!GetLastInputInfo(ref lii)) return 0;
    return unchecked((uint)Environment.TickCount - lii.dwTime);
  }
}
'@
while ($true) { [Console]::Out.WriteLine([UserIdle]::GetIdleMs()); Start-Sleep -Seconds 15 }
`;

/** Pure decision function — fail-open: a broken/absent detector must degrade to "push everything". */
export function computeAway(sample: Sample | null, nowMs: number, thresholdMs: number): boolean {
  if (!sample) return true;
  if (nowMs - sample.receivedAt > STALE_SAMPLE_MS) return true;
  const idleNow = sample.idleMs + (nowMs - sample.receivedAt);
  return idleNow >= thresholdMs;
}

export function startAwayDetector(deps: AwayDetectorDeps): AwayDetector {
  const { config, log } = deps;

  let sample: Sample | null = null;
  let child: ChildProcess | undefined;
  let respawnTimer: NodeJS.Timeout | undefined;
  let stopped = false;
  let respawnScheduled = false;

  function scheduleRespawn(why: string): void {
    if (stopped || respawnScheduled) return;
    respawnScheduled = true;
    log.warn(`awayDetector: ${why}, respawning in 30s`);
    respawnTimer = setTimeout(() => {
      respawnScheduled = false;
      spawnChild();
    }, RESPAWN_DELAY_MS);
    respawnTimer.unref();
  }

  function spawnChild(): void {
    if (stopped) return;
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', POLL_SCRIPT], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      const idle = Number(line.trim());
      if (Number.isFinite(idle)) {
        sample = { idleMs: idle, receivedAt: Date.now() };
      }
    });

    child.on('error', (err) => scheduleRespawn(`idle-poll child error (${err.message})`));
    child.on('exit', () => scheduleRespawn('idle-poll child exited'));
  }

  if (process.platform === 'win32') {
    spawnChild();
  } else {
    log.warn('awayDetector: no idle detection on this platform, treating user as always away');
  }

  function isAway(): boolean {
    if (process.platform !== 'win32') return true;
    return computeAway(sample, Date.now(), config.push.awayThresholdMinutes * 60_000);
  }

  function idleMs(): number | null {
    if (!sample) return null;
    return sample.idleMs + (Date.now() - sample.receivedAt);
  }

  function stop(): void {
    stopped = true;
    if (respawnTimer) clearTimeout(respawnTimer);
    child?.kill();
  }

  return { isAway, idleMs, stop };
}
