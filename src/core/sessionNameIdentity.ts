// Pure helper: decides whether a Claude Code `session_name` (what `/name <x>` sets, or CC's own
// auto-generated conversation title — see CLAUDE.md's "Session names" subsection) looks like a
// deliberate short identity label the hub should adopt as the INSTANCE's name, as opposed to CC's
// auto-title. The statusline payload carries no flag distinguishing the two, so word count is the
// only signal available: a human naming a running agent picks something terse ("wb-sync", "csv
// export"); CC's auto-titles read like sentences ("Display agent info on console top line" = 7
// words) — that's the actual example this feature was built against.
import { INSTANCE_NAME_RE } from './identity.js';

const MAX_WORDS = 3;
const MAX_SLUG_LENGTH = 40;

// Returns the candidate instance name, or null when this session_name must NOT be adopted (still
// fine to store for display — see hooksRoutes.ts's POST /hooks/session-name).
export function slugifySessionName(name: string): string | null {
  const original = name.trim();
  if (original.length === 0) return null;

  // Word count is measured on the ORIGINAL (pre-slug) text, before punctuation is stripped — a
  // sentence-like auto-title has several whitespace-separated words; a deliberate label has few.
  const wordCount = original.split(/\s+/).filter((w) => w.length > 0).length;
  if (wordCount > MAX_WORDS) return null;

  let slug = original.toLowerCase();
  slug = slug.replace(/\s+/g, ' ').trim(); // collapse whitespace
  slug = slug.replace(/[ _]/g, '-'); // spaces/underscores -> '-'
  slug = slug.replace(/[^a-z0-9_-]/g, ''); // strip anything outside [a-z0-9_-]
  slug = slug.replace(/-+/g, '-'); // collapse repeated '-'
  slug = slug.replace(/^-+|-+$/g, ''); // trim leading/trailing '-'

  if (slug.length === 0 || slug.length > MAX_SLUG_LENGTH) return null;
  if (!INSTANCE_NAME_RE.test(slug)) return null;
  return slug;
}
