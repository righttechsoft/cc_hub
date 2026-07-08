import type Database from 'better-sqlite3';
import type { HubConfig, IContinuationRunner, IPromptDelivery, Logger, SessionRow } from '../types.js';
import { HubBus } from '../core/bus.js';
import * as sessions from '../db/repo/sessions.js';
import * as limitRepo from '../db/repo/limit.js';

export interface ContinuationRunnerDeps {
  db: Database.Database;
  bus: HubBus;
  log: Logger;
  delivery: IPromptDelivery;
  config: HubConfig;
}

function todayLocalDateString(now: number): string {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export class ContinuationRunner implements IContinuationRunner {
  private readonly db: Database.Database;
  private readonly bus: HubBus;
  private readonly log: Logger;
  private readonly delivery: IPromptDelivery;
  private readonly config: HubConfig;

  constructor(deps: ContinuationRunnerDeps) {
    this.db = deps.db;
    this.bus = deps.bus;
    this.log = deps.log;
    this.delivery = deps.delivery;
    this.config = deps.config;
  }

  // Serialized per maxConcurrent: a value of 1 processes strictly one session at a time;
  // larger values process that many concurrently per chunk before moving to the next chunk.
  async run(sessionsToRun: SessionRow[]): Promise<void> {
    const chunkSize = Math.max(1, this.config.autoContinue.maxConcurrent);
    for (let i = 0; i < sessionsToRun.length; i += chunkSize) {
      const chunk = sessionsToRun.slice(i, i + chunkSize);
      await Promise.all(chunk.map((session) => this.runOne(session)));
    }
  }

  private async runOne(session: SessionRow): Promise<void> {
    const now = Date.now();

    if (session.auto_continue === 0) {
      this.log.info(`continuation: skip ${session.id} — auto_continue disabled`);
      return;
    }
    if (session.status === 'ended') {
      this.log.info(`continuation: skip ${session.id} — session ended`);
      return;
    }

    const today = todayLocalDateString(now);
    const continuesToday = session.continues_date === today ? session.continues_today : 0;
    if (continuesToday >= this.config.autoContinue.maxPerSessionPerDay) {
      this.log.info(`continuation: skip ${session.id} — daily cap reached (${continuesToday})`);
      return;
    }

    // Everything past this point is wrapped in one try/catch so a single session's failure
    // (delivery error, unexpected DB error) never aborts the rest of the queue.
    try {
      sessions.setStatus(this.db, session.id, 'continuing', now);
      limitRepo.recordEvent(this.db, 'continue_started', { sessionId: session.id }, now);
      sessions.bumpContinues(this.db, session.id, today);

      await this.delivery.send(session.id, this.config.autoContinue.prompt, 'limit_watcher');

      limitRepo.recordEvent(this.db, 'continue_done', { sessionId: session.id }, Date.now());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`continuation: failed for session ${session.id}: ${message}`);
      limitRepo.recordEvent(this.db, 'continue_failed', { sessionId: session.id, error: message }, Date.now());
    }
  }
}
