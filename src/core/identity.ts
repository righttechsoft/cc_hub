import type Database from 'better-sqlite3';
import { basename, dirname } from 'node:path';

function takenByOtherCwd(db: Database.Database, name: string, cwd: string): boolean {
  return (
    db.prepare('SELECT 1 FROM instances WHERE name = ? AND cwd != ? LIMIT 1').get(name, cwd) !== undefined
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
