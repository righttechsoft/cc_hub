import type Database from 'better-sqlite3';
import { basename, dirname } from 'node:path';
import type { IAttachRegistry, InstanceNameSource, RenameBindingSource } from '../types.js';
import * as instancesRepo from '../db/repo/instances.js';

// Shared validation for an explicit instance name (cc-attach --name / CC_HUB_NAME / hub_register
// name / admin rename) — lowercase first, then test. Kept permissive enough for a short
// task-style label but restrictive enough to be a safe filename fragment (topBar.ts's
// `cc-title-<name>.txt`) and a safe chat/inbox address.
export const INSTANCE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

function cwdEquals(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// "Taken" for the purpose of picking a cwd-derived default name: any row with this name, UNLESS
// it's the exact default (named=0) row this cwd would itself reuse. A named sibling row at the
// same cwd sharing this name is a real collision (name is globally UNIQUE) and must NOT be
// silently ignored just because it happens to live at the same cwd.
function takenByOtherCwd(db: Database.Database, name: string, cwd: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM instances WHERE name = ? AND NOT (cwd = ? COLLATE NOCASE AND named = 0) LIMIT 1")
      .get(name, cwd) !== undefined
  );
}

export function instanceNameFromCwd(db: Database.Database, cwd: string): string {
  const base = basename(cwd).toLowerCase();
  if (!takenByOtherCwd(db, base, cwd)) return base;

  const parent = basename(dirname(cwd)).toLowerCase();
  const parentBase = `${parent}-${base}`;
  if (!takenByOtherCwd(db, parentBase, cwd)) return parentBase;

  // Both the bare basename and the parent-prefixed candidate are already taken by some other
  // cwd (e.g. two distinct checkouts both laid out as <root>\backend\api) — disambiguate with
  // a numeric suffix until we find a name that isn't claimed by anyone else.
  let n = 2;
  let candidate = `${parentBase}-${n}`;
  while (takenByOtherCwd(db, candidate, cwd)) {
    n += 1;
    candidate = `${parentBase}-${n}`;
  }
  return candidate;
}

export interface ResolvedExplicitName {
  name: string;
  // true when `requestedName` was already claimed by a DIFFERENT cwd and had to be disambiguated
  // with a numeric suffix — callers should log a warning when this fires.
  collided: boolean;
}

// Resolution rule for an EXPLICITLY requested instance name (cc-attach --name / CC_HUB_NAME /
// hub_register's `name` arg): reuse the existing instance row iff `name` is already claimed by
// THIS cwd (NOCASE); if it's claimed by a DIFFERENT cwd, disambiguate with a numeric suffix (same
// machinery as instanceNameFromCwd) and flag `collided` so the caller can warn; if unclaimed,
// return it as-is for the caller to create. `requestedName` must already be lowercased and
// pass INSTANCE_NAME_RE — this function does not validate format, only uniqueness.
export function resolveExplicitInstanceName(
  db: Database.Database,
  requestedName: string,
  cwd: string
): ResolvedExplicitName {
  const existing = db.prepare('SELECT cwd FROM instances WHERE name = ?').get(requestedName) as
    | { cwd: string }
    | undefined;

  if (!existing) return { name: requestedName, collided: false };
  if (cwdEquals(existing.cwd, cwd)) return { name: requestedName, collided: false };

  // Claimed by a different cwd — disambiguate with a numeric suffix until free.
  let n = 2;
  let candidate = `${requestedName}-${n}`;
  while (db.prepare('SELECT 1 FROM instances WHERE name = ? LIMIT 1').get(candidate) !== undefined) {
    n += 1;
    candidate = `${requestedName}-${n}`;
  }
  return { name: candidate, collided: true };
}

export interface InstanceRenameDeps {
  db: Database.Database;
  attach: IAttachRegistry;
  // Optional so a caller with no live MCP gateway yet (or one that can't construct it lazily)
  // doesn't need a fake — mirrors apiRoutes.ts's pre-existing optional `gateway` dep.
  gateway?: RenameBindingSource;
}

// Shared "rename a live instance" plumbing — the admin page's ✎ rename (src/http/apiRoutes.ts)
// and session-name adoption (src/http/hooksRoutes.ts's POST /hooks/session-name, see
// CLAUDE.md's "Session names" subsection) both need to: durably rename the row (recording
// provenance via `nameSource`), then re-key the two pieces of LIVE in-memory state that are keyed
// by name so already-running chat/attach/MCP routing keeps resolving to the right row without a
// restart — the attach registry's client slot and any open hub_register MCP binding. Both are
// no-ops if nothing is currently live under the old name. Callers must already have validated the
// new name's format and checked for a collision with a DIFFERENT instance.
export function applyInstanceRename(
  deps: InstanceRenameDeps,
  id: number,
  oldName: string,
  newName: string,
  nameSource: InstanceNameSource
): void {
  instancesRepo.rename(deps.db, id, newName, nameSource);
  deps.attach.rename?.(oldName, newName);
  deps.gateway?.renameBinding(oldName, newName);
}
