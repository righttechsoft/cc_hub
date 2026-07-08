import type Database from 'better-sqlite3';
import type { HubBus } from '../core/bus.js';
import { renderStopBlockPrompt } from '../core/messageFormat.js';
import * as sessionsRepo from '../db/repo/sessions.js';
import * as promptsRepo from '../db/repo/prompts.js';
import * as eventsRepo from '../db/repo/events.js';
import type { HubConfig, IClaudeRunner, IPromptDelivery, Logger, PendingPromptSource, PendingPromptStatus } from '../types.js';

export interface PromptDeliveryDeps {
  db: Database.Database;
  bus: HubBus;
  log: Logger;
  runner: IClaudeRunner;
  config: HubConfig;
}

/** Idle-session→spawn / mid-turn→queue routing for remote (mobile/limit-watcher/api) prompts. */
export class PromptDelivery implements IPromptDelivery {
  constructor(private readonly deps: PromptDeliveryDeps) {}

  async send(
    sessionId: string,
    prompt: string,
    source: string,
  ): Promise<{ delivery: 'queued' | 'spawned'; pendingPromptId: number }> {
    const { db, runner, bus, log, config } = this.deps;

    const session = sessionsRepo.getJoined(db, sessionId);
    if (!session) {
      throw new Error(`PromptDelivery: unknown session ${sessionId}`);
    }

    const promptSource = source as PendingPromptSource;

    if (session.status === 'active' || runner.isRunning(sessionId)) {
      const row = promptsRepo.enqueue(db, {
        sessionId,
        prompt,
        source: promptSource,
        status: 'queued',
        now: Date.now(),
      });
      return { delivery: 'queued', pendingPromptId: row.id };
    }

    const row = promptsRepo.enqueue(db, {
      sessionId,
      prompt,
      source: promptSource,
      status: 'delivering',
      now: Date.now(),
    });

    const permissionMode = source === 'limit_watcher' ? config.autoContinue.permissionMode : undefined;

    // If the spawn is enqueued while the session sits in 'continuing' (ContinuationRunner) and
    // then fails/errors, no hook will ever fire to move it out of that status — revert it back
    // to 'interrupted' here so the next watcher tick retries it, instead of leaving it stuck.
    const revertStuckContinuing = (): void => {
      const current = sessionsRepo.get(db, sessionId);
      if (current?.status === 'continuing') {
        sessionsRepo.setStatus(db, sessionId, 'interrupted', Date.now());
        bus.emit({ type: 'session_status', sessionId, status: 'interrupted' });
      }
    };

    runner
      .resumePrompt({ sessionId, cwd: session.cwd, prompt, permissionMode })
      .then((result) => {
        const status: PendingPromptStatus = result.code === 0 ? 'delivered' : 'failed';
        promptsRepo.setStatus(
          db,
          row.id,
          status,
          status === 'failed' ? result.stderr || `exit code ${String(result.code)}` : undefined,
        );
        if (status === 'failed') revertStuckContinuing();
        eventsRepo.record(db, {
          sessionId,
          instanceName: session.instance_name,
          type: 'remote_prompt',
          payload: { prompt, source: promptSource, delivery: 'spawned', status, code: result.code },
          now: Date.now(),
        });
        bus.emit({
          type: 'session_event',
          sessionId,
          eventType: 'remote_prompt',
          payload: { prompt, source: promptSource, delivery: 'spawned', status },
          createdAt: Date.now(),
        });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        promptsRepo.setStatus(db, row.id, 'failed', message);
        revertStuckContinuing();
        eventsRepo.record(db, {
          sessionId,
          instanceName: session.instance_name,
          type: 'remote_prompt',
          payload: { prompt, source: promptSource, delivery: 'spawned', status: 'failed', error: message },
          now: Date.now(),
        });
        bus.emit({
          type: 'session_event',
          sessionId,
          eventType: 'remote_prompt',
          payload: { prompt, source: promptSource, delivery: 'spawned', status: 'failed', error: message },
          createdAt: Date.now(),
        });
        log.warn(`PromptDelivery: resumePrompt failed for session ${sessionId}`, { error: message });
      });

    return { delivery: 'spawned', pendingPromptId: row.id };
  }

  claimForStopBlock(sessionId: string): { reason: string } | undefined {
    const { db } = this.deps;

    const next = promptsRepo.nextQueued(db, sessionId);
    if (!next) return undefined;

    promptsRepo.setStatus(db, next.id, 'delivered');

    const session = sessionsRepo.getJoined(db, sessionId);
    eventsRepo.record(db, {
      sessionId,
      instanceName: session?.instance_name ?? null,
      type: 'remote_prompt',
      payload: { prompt: next.prompt, source: next.source, delivery: 'stop_block' },
      now: Date.now(),
    });

    return { reason: renderStopBlockPrompt(next.prompt) };
  }
}
