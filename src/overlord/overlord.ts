// AI Overlord: natural-language questions over past Claude Code sessions ("find a session where
// I did X"), surfaced in the admin page's "AI Overlord" tab. Two-stage RAG-lite, both AI calls via
// the same CC-OAuth-token fetch pattern as src/notify/needsInputFilter.ts / src/chat/messageSummarizer.ts:
//   1. classify      — one small-model call turns the question into a 'find' request (3-8 lowercase
//      search terms), a 'digest' request (a project/instance/folder scope to summarize across all
//      its recent sessions), or an 'ask' request (a message to send live instances directly — see
//      below); fail-soft (no token/network/bad response/unparseable) falls back to 'find' with the
//      question's own words.
//   2a. search (find mode)   — pure Node: tail-reads recent transcripts under ~/.claude/projects for
//      the terms (see src/limit/transcriptScan.ts for the tail-read pattern this mirrors) plus a
//      plain LIKE scan over the messages table for inter-agent chatter. No AI involved in this stage.
//   2b. digest (digest mode) — pure Node: looks up sessions (any status) whose instance name or cwd
//      contains the scope, newest-first, capped at 6; tail-reads each transcript and keeps its last
//      25 user/assistant entries. Zero matches falls back to find mode using the scope as a term.
//   3. answer         — a second small-model call composes a plain-text answer referencing the
//      candidate sessions as [1], [2]...; fail-soft to a canned "AI unavailable" answer that still
//      returns the raw candidates. Digest mode uses its own summarization prompt/word cap.
// Search never breaks: any failure at any stage degrades gracefully rather than throwing.
// Ask mode is a different shape entirely — no AI answer, no transcript search. classify resolves
// the target instances (name/cwd match on scope) then, by default, keeps only LIVE ones (an open
// cc-attach terminal or a mid-turn session — see isLiveInstance in OverlordDeps); the rest are
// reported back as `excluded` rather than silently dropped, since reaching a dead instance would
// cost a headless claude spawn. "including inactive" in the question opts back into all matches.
// ask() returns { targets, excluded } alongside the rewritten message for the admin route to show
// as a confirmation; nothing is sent until a human clicks Send (POST /api/v1/admin/overlord-send
// in apiRoutes.ts), which messages 'overlord' as the reserved sender directly to each target
// through the normal chat delivery machinery.
// Dispatch mode assigns a task to a project rather than asking/telling an existing live agent
// something — classify resolves {scope, task, name}; resolveDispatchPlan (pure lookup, no side
// effects) finds every instance matching scope, decorates each with liveness (attached/working —
// see getInstanceLiveness in OverlordDeps, backed by src/attach/attachRegistry.ts), and calls
// src/spawn/dispatcher.ts's decideDispatch to choose between reusing the first idle attached
// candidate or opening a brand-new terminal tab. Like ask mode, nothing is executed at
// classification time — ask() just returns the plan for the admin route to confirm
// (renderOverlordDispatchConfirm); the actual inject-or-spawn happens from a second, explicit
// POST /api/v1/admin/overlord-dispatch.
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { HubConfig, Logger, MessageRow, SessionJoined } from '../types.js';
import { readAccessToken } from '../limit/credentials.js';
import * as sessionsRepo from '../db/repo/sessions.js';
import * as instancesRepo from '../db/repo/instances.js';
import { INSTANCE_NAME_RE } from '../core/identity.js';
import { decideDispatch, type DispatchAction, type DispatchCandidate } from '../spawn/dispatcher.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const CALL_TIMEOUT_MS = 15000;

const MAX_TERMS = 8;
const MIN_TERM_LEN = 4;

const SNIPPET_RADIUS = 200;
const MAX_SNIPPETS_PER_SESSION = 8;
const MAX_SNIPPETS_OVERALL = 40;

const MAX_MESSAGE_ROWS_PER_TERM = 10;
const MAX_RESULT_CANDIDATES = 10;
const MAX_CANDIDATE_SNIPPETS_IN_PROMPT = 3;
const CANDIDATE_SNIPPET_CLIP = 300;

// Digest mode: scoped "summarize recent activity" questions (see createOverlord's ask()).
const DIGEST_SESSION_CAP = 6;
const DIGEST_MAX_ENTRIES = 25;
const DIGEST_ENTRY_CLIP = 300;
const DIGEST_CARD_SNIPPETS = 3;

// Ask mode: "tell/ask the live agents something" questions (see resolveAskTargets below).
// Instances carry no activity column to rank by, so target selection is just alphabetical
// (instancesRepo.list's own order) rather than recency-sorted like digest mode's sessions.
// Targets default to LIVE instances only (an open cc-attach terminal or a mid-turn session) —
// anything else would only ever be reached via a fresh headless spawn, and most registered
// instances are stale project folders nobody has open. "including inactive" in the question
// (Stage 1's includeInactive flag) widens the net back to every scope match.
const ASK_TARGET_CAP = 8;
// Cap on how many skipped/non-live matches the confirmation UI lists by name — display only,
// doesn't affect which instances are reachable (that's ASK_TARGET_CAP above).
const ASK_EXCLUDED_DISPLAY_CAP = 12;

const DAY_MS = 24 * 60 * 60 * 1000;

const FALLBACK_ANSWER = 'AI unavailable — showing raw matches.';

const STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'have', 'about', 'what', 'when', 'where', 'which', 'while',
  'would', 'could', 'should', 'there', 'their', 'been', 'were', 'does', 'doing', 'find', 'session',
  'sessions', 'using', 'into', 'your', 'they', 'them', 'then', 'than', 'these', 'those', 'also',
  'just', 'like', 'some', 'such', 'more', 'most', 'over', 'under', 'only', 'very', 'again', 'each',
  'other', 'want', 'need', 'know', 'time', 'make', 'made', 'work', 'good', 'well', 'much', 'many',
]);

// Stage 1 classifies the question as either 'find' (locate a specific past session — the original
// behavior, terms as before) or 'digest' (summarize/aggregate recent activity across ALL the
// sessions of one named project/instance/folder — scope carries that name). Keyword retrieval for a
// scoped digest question misses sessions that don't happen to use the question's exact wording, so
// digest mode looks the scope up directly against known sessions instead (see runDigest below).
const CLASSIFY_SYSTEM_PROMPT =
  "Classify the user's question about their past or live Claude Code coding sessions, then reply with ONLY " +
  'a JSON object, nothing else — no markdown, no commentary.\n' +
  'If the question asks to summarize, digest, or report on recent activity across ALL the sessions ' +
  'of one named project, instance, or folder (e.g. "what has wonkybox been doing", "summarize all ' +
  'foo sessions", "status of the bar project"), reply exactly in this shape: ' +
  '{"mode":"digest","scope":"<the project/instance/folder name mentioned, a single short string>","terms":[]}\n' +
  'If the question asks to TELL or ASK one or more live agent sessions something directly — instructing ' +
  'them to do something, or asking them a question they should answer back (e.g. "ask all wonkybox ' +
  'sessions what is blocking them", "tell taskmaster to push its branch") — reply exactly in this shape: ' +
  '{"mode":"ask","scope":"<project/instance/folder name mentioned, or null for everyone>",' +
  '"includeInactive":<true ONLY if the question explicitly says to also reach inactive/closed/old ' +
  'sessions, or to spawn new sessions if needed (e.g. "including inactive", "even closed sessions", ' +
  '"all instances, spawn if needed"); false otherwise, which is the default>,' +
  '"message":"<the question or instruction rewritten as a direct, self-contained, imperative message to ' +
  'send the agent(s), e.g. \'What is currently blocking you? Please reply.\'>"}\n' +
  'If the question asks to START WORK on something — implement, build, fix, or otherwise begin a new ' +
  'task in one named project, instance, or folder (e.g. "implement the CSV export in wonkybox2_api", ' +
  '"have someone fix the failing tests in taskmaster") — reply exactly in this shape: ' +
  '{"mode":"dispatch","scope":"<the project/instance/folder name mentioned, a single short string>",' +
  '"task":"<the instruction rewritten as a self-contained prompt for the agent that will do the work>",' +
  '"name":"<a short kebab-case identity for this task, e.g. \'fix-csv-export\'>"}\n' +
  'Otherwise, reply in this shape: {"mode":"find","scope":null,"terms":[...]} where terms is 3-8 ' +
  'short lowercase search terms or phrases likely to appear verbatim in the session transcripts, e.g. ' +
  '{"mode":"find","scope":null,"terms":["date bug","meeting card","calendar"]}';

const ANSWER_SYSTEM_PROMPT =
  'You help a developer find a past Claude Code coding session. Given their question and a numbered ' +
  'list of candidate sessions (each with folder, last activity, and snippets), answer which session(s) ' +
  'match and why, referencing them as [1], [2] etc. If none match, say so plainly. Plain text only, ' +
  'at most 150 words.';

const DIGEST_ANSWER_SYSTEM_PROMPT =
  'You help a developer catch up on recent work across multiple Claude Code coding sessions that ' +
  'belong to one project. Given their question and a numbered list of candidate sessions (each with ' +
  'instance/folder/status/last-activity and its recent user/assistant transcript entries), summarize ' +
  'EACH session separately, covering: (a) recent work done, (b) what was pushed, committed, or ' +
  'deployed, (c) what is still pending, waiting, or unanswered. Cite sessions as [1], [2] etc. If a ' +
  'note says only the most recent sessions in scope are shown, mention that older sessions were ' +
  'omitted. Plain text only, at most 250 words.';

// --- Pure helpers (unit-tested in overlord.test.ts) ---

// Fallback term extraction: the question's own words >= 4 chars, minus stopwords, deduped, cap 8.
export function fallbackTerms(question: string): string[] {
  const words = question.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of words) {
    const word = raw.replace(/^'+|'+$/g, '');
    if (word.length < MIN_TERM_LEN || STOPWORDS.has(word) || seen.has(word)) continue;
    seen.add(word);
    terms.push(word);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms;
}

// Parses stage-1's model response ("JSON array of strings only"). Any deviation — invalid JSON,
// non-array, non-string elements, an empty result — falls back to the question's own words rather
// than erroring or returning nothing.
export function parseTermsResponse(raw: string, question: string): string[] {
  const candidates = [raw.trim()];
  // Models occasionally wrap the array in a fenced code block despite the "ONLY" instruction —
  // salvage the substring between the first '[' and last ']' as a second attempt.
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start !== -1 && end > start) candidates.push(raw.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (!Array.isArray(parsed)) continue;
      const terms = parsed
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0);
      if (terms.length > 0) return terms.slice(0, MAX_TERMS);
    } catch {
      continue;
    }
  }
  return fallbackTerms(question);
}

function normalizeTerms(parsed: unknown[]): string[] {
  return parsed
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0)
    .slice(0, MAX_TERMS);
}

export interface Stage1Classification {
  mode: 'find' | 'digest' | 'ask' | 'dispatch';
  scope: string | null;
  terms: string[];
  // Only set for mode 'ask' — the question/instruction rewritten as a direct message to send the
  // target agent(s). Left undefined for 'find'/'digest'/'dispatch' so existing object-equality
  // tests (toEqual ignores undefined properties) keep passing unchanged.
  message?: string;
  // Only set for mode 'ask' — true only when the question explicitly widened the net to inactive/
  // closed instances ("including inactive", "even old sessions", "spawn if needed"). Absent field
  // in the model's JSON (or any non-'ask' mode) reads as false, same undefined-property treatment
  // as `message` above.
  includeInactive?: boolean;
  // Only set for mode 'dispatch' — the instruction rewritten as a self-contained prompt for the
  // agent that will do the work.
  task?: string;
  // Only set for mode 'dispatch' — a short kebab-case task identity, already normalized against
  // INSTANCE_NAME_RE (see normalizeDispatchName) so downstream code never has to re-validate it.
  name?: string;
}

// Normalizes a dispatch-mode task identity to something safe to use as an instance name and a
// terminal title: lowercase, any character outside [a-z0-9_-] becomes '-', truncated to
// INSTANCE_NAME_RE's max length. Anything that still doesn't match the regex afterwards (empty
// input, or a string that ended up with no valid leading character) falls back to the literal
// 'task' rather than rejecting the whole dispatch classification over a cosmetic name.
export function normalizeDispatchName(raw: string): string {
  const candidate = raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40);
  return INSTANCE_NAME_RE.test(candidate) ? candidate : 'task';
}

// Parses stage-1's model response now that it can reply either with the original bare JSON array of
// terms (kept for back-compat — treated as {mode:'find', terms}) or one of the newer object shapes:
// {"mode":"find"|"digest","scope":string|null,"terms":string[]} or
// {"mode":"ask","scope":string|null,"message":string}. Tries, in order: the raw trimmed text, the
// substring between the first '{' and last '}' (salvages a fenced/prefixed object), and the
// substring between the first '[' and last ']' (salvages a fenced/prefixed array — same trick
// parseTermsResponse uses). A 'digest' object without a usable non-empty scope, an 'ask' object
// without a usable non-empty message, or a 'find' object without any usable terms, isn't
// actionable, so parsing falls through to the next candidate; if nothing usable is found anywhere,
// falls back to {mode:'find', terms: fallbackTerms}.
export function parseStage1Response(raw: string, question: string): Stage1Classification {
  const candidates = [raw.trim()];
  const objStart = raw.indexOf('{');
  const objEnd = raw.lastIndexOf('}');
  if (objStart !== -1 && objEnd > objStart) candidates.push(raw.slice(objStart, objEnd + 1));
  const arrStart = raw.indexOf('[');
  const arrEnd = raw.lastIndexOf(']');
  if (arrStart !== -1 && arrEnd > arrStart) candidates.push(raw.slice(arrStart, arrEnd + 1));

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }

    if (Array.isArray(parsed)) {
      const terms = normalizeTerms(parsed);
      if (terms.length > 0) return { mode: 'find', scope: null, terms };
      continue;
    }

    if (parsed && typeof parsed === 'object') {
      const obj = parsed as {
        mode?: unknown;
        scope?: unknown;
        terms?: unknown;
        message?: unknown;
        includeInactive?: unknown;
        task?: unknown;
        name?: unknown;
      };
      if (obj.mode === 'digest') {
        const scope = typeof obj.scope === 'string' ? obj.scope.trim() : '';
        if (scope.length > 0) return { mode: 'digest', scope, terms: [] };
        continue;
      }
      if (obj.mode === 'ask') {
        const message = typeof obj.message === 'string' ? obj.message.trim() : '';
        if (message.length > 0) {
          const scope = typeof obj.scope === 'string' && obj.scope.trim().length > 0 ? obj.scope.trim() : null;
          const includeInactive = obj.includeInactive === true;
          return { mode: 'ask', scope, terms: [], message, includeInactive };
        }
        continue;
      }
      if (obj.mode === 'dispatch') {
        const scope = typeof obj.scope === 'string' ? obj.scope.trim() : '';
        const task = typeof obj.task === 'string' ? obj.task.trim() : '';
        if (scope.length > 0 && task.length > 0) {
          const rawName = typeof obj.name === 'string' && obj.name.trim().length > 0 ? obj.name : task;
          const name = normalizeDispatchName(rawName);
          return { mode: 'dispatch', scope, terms: [], task, name };
        }
        continue;
      }
      if (obj.mode === 'find') {
        const terms = Array.isArray(obj.terms) ? normalizeTerms(obj.terms) : [];
        if (terms.length > 0) return { mode: 'find', scope: null, terms };
        continue;
      }
    }
  }

  return { mode: 'find', scope: null, terms: fallbackTerms(question) };
}

export interface TranscriptSnippetHit {
  snippet: string;
  timestampMs: number | null;
  cwd: string | null;
}

interface RawTranscriptLine {
  type?: unknown;
  isSidechain?: unknown;
  isMeta?: unknown;
  timestamp?: unknown;
  cwd?: unknown;
  message?: { content?: unknown };
}

function extractLineText(raw: RawTranscriptLine): string | null {
  if (raw.type !== 'user' && raw.type !== 'assistant') return null;
  const content = raw.message?.content;
  if (typeof content === 'string') return content.length > 0 ? content : null;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content as unknown[]) {
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        parts.push((block as { text: string }).text);
      }
    }
    return parts.length > 0 ? parts.join('\n') : null;
  }
  return null;
}

// Scans a transcript tail (or any JSONL buffer) for lines matching any of `terms` (case-insensitive
// substring on the raw line, so a hit can't be missed by parsing first). On a hit: JSON-parse the
// line (fail-soft — malformed/partial lines from a tail read are skipped, not treated as evidence),
// extract user/assistant text, and take a +-200-char window around the first term match in that
// text. Stops once `maxSnippets` hits are collected (this is the per-session cap; the overall cap
// across sessions is enforced by the caller).
export function extractSnippets(
  transcriptTail: string,
  terms: string[],
  maxSnippets: number = MAX_SNIPPETS_PER_SESSION
): TranscriptSnippetHit[] {
  if (terms.length === 0 || maxSnippets <= 0) return [];
  const lowerTerms = terms.map((t) => t.toLowerCase()).filter((t) => t.length > 0);
  if (lowerTerms.length === 0) return [];

  const hits: TranscriptSnippetHit[] = [];
  for (const rawLine of transcriptTail.split('\n')) {
    if (hits.length >= maxSnippets) break;
    const line = rawLine.trim();
    if (!line) continue;
    const lowerLine = line.toLowerCase();
    if (!lowerTerms.some((t) => lowerLine.includes(t))) continue;

    let parsed: RawTranscriptLine;
    try {
      parsed = JSON.parse(line) as RawTranscriptLine;
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    if (parsed.isSidechain === true || parsed.isMeta === true) continue;

    const text = extractLineText(parsed);
    if (!text) continue;
    const lowerText = text.toLowerCase();

    let idx = -1;
    for (const t of lowerTerms) {
      const i = lowerText.indexOf(t);
      if (i !== -1 && (idx === -1 || i < idx)) idx = i;
    }
    // The raw line matched (e.g. inside a tool_input field) but the extracted user/assistant text
    // itself doesn't contain any term — nothing meaningful to snippet.
    if (idx === -1) continue;

    const start = Math.max(0, idx - SNIPPET_RADIUS);
    const end = Math.min(text.length, idx + SNIPPET_RADIUS);
    let snippet = text.slice(start, end);
    if (start > 0) snippet = '…' + snippet;
    if (end < text.length) snippet = snippet + '…';

    const ts = typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : NaN;
    hits.push({
      snippet,
      timestampMs: Number.isNaN(ts) ? null : ts,
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : null,
    });
  }
  return hits;
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

// Digest mode's per-session transcript read: unlike extractSnippets (term-matched), this keeps every
// user/assistant text line unconditionally (there are no search terms in digest mode) and returns
// the LAST `maxEntries` of them, each role-tagged ("user: …" / "assistant: …") and clipped — recency
// matters more than volume for a "what have you been doing" summary. Same fail-soft line handling as
// extractSnippets (skip malformed/sidechain/meta lines, skip lines with no extractable text).
export function extractDigestEntries(
  transcriptTail: string,
  maxEntries: number = DIGEST_MAX_ENTRIES
): string[] {
  const entries: string[] = [];
  for (const rawLine of transcriptTail.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    let parsed: RawTranscriptLine;
    try {
      parsed = JSON.parse(line) as RawTranscriptLine;
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    if (parsed.isSidechain === true || parsed.isMeta === true) continue;

    const text = extractLineText(parsed);
    if (!text) continue;
    const role = parsed.type === 'user' ? 'user' : 'assistant';
    entries.push(`${role}: ${clip(text, DIGEST_ENTRY_CLIP)}`);
  }
  return entries.slice(-maxEntries);
}

// --- AI calls ---

// Stage 1: classifies the question into 'find' or 'digest' (see CLASSIFY_SYSTEM_PROMPT above).
// Fail-soft at every step (no token, non-2xx, empty text, thrown error) degrades to 'find' with the
// question's own fallback words — same contract callTermsModel used to have, just wrapped in the
// richer classification shape.
async function classifyQuestion(
  question: string,
  config: HubConfig,
  log: Logger,
  fetchFn: typeof fetch
): Promise<Stage1Classification> {
  const token = readAccessToken();
  if (!token) {
    log.debug('overlord: no access token available, falling back to keyword terms');
    return { mode: 'find', scope: null, terms: fallbackTerms(question) };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetchFn(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.overlord.model,
        max_tokens: 200,
        system: CLASSIFY_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: question }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      log.debug('overlord: classify request failed', { status: res.status });
      return { mode: 'find', scope: null, terms: fallbackTerms(question) };
    }

    const json = (await res.json()) as { content?: { text?: string }[] };
    const text = (json.content?.[0]?.text ?? '').trim();
    if (!text) return { mode: 'find', scope: null, terms: fallbackTerms(question) };
    return parseStage1Response(text, question);
  } catch (err) {
    log.debug('overlord: classify request threw', { error: err instanceof Error ? err.message : String(err) });
    return { mode: 'find', scope: null, terms: fallbackTerms(question) };
  } finally {
    clearTimeout(timer);
  }
}

async function callAnswerModel(
  question: string,
  userContent: string,
  config: HubConfig,
  log: Logger,
  fetchFn: typeof fetch,
  systemPrompt: string = ANSWER_SYSTEM_PROMPT
): Promise<string> {
  const token = readAccessToken();
  if (!token) {
    log.debug('overlord: no access token available, returning fallback answer');
    return FALLBACK_ANSWER;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  try {
    const res = await fetchFn(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: config.overlord.model,
        max_tokens: 400,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      log.debug('overlord: answer request failed', { status: res.status });
      return FALLBACK_ANSWER;
    }

    const json = (await res.json()) as { content?: { text?: string }[] };
    const text = (json.content?.[0]?.text ?? '').trim();
    return text.length > 0 ? text : FALLBACK_ANSWER;
  } catch (err) {
    log.debug('overlord: answer request threw', {
      question,
      error: err instanceof Error ? err.message : String(err),
    });
    return FALLBACK_ANSWER;
  } finally {
    clearTimeout(timer);
  }
}

// --- Stage 2: search (pure Node, no AI) ---

interface TranscriptFileMeta {
  path: string;
  sessionId: string;
  mtimeMs: number;
}

async function listTranscriptFiles(rootDir: string, sinceMs: number, log: Logger): Promise<TranscriptFileMeta[]> {
  const files: TranscriptFileMeta[] = [];
  let projectDirs: string[];
  try {
    projectDirs = await readdir(rootDir);
  } catch (err) {
    log.debug('overlord: cannot read projects dir', {
      rootDir,
      error: err instanceof Error ? err.message : String(err),
    });
    return files;
  }

  for (const projectDir of projectDirs) {
    const dirPath = join(rootDir, projectDir);
    let entries: string[];
    try {
      entries = await readdir(dirPath);
    } catch {
      continue; // not a directory, or unreadable — skip
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const filePath = join(dirPath, entry);
      try {
        const st = await stat(filePath);
        if (st.mtimeMs < sinceMs) continue;
        files.push({ path: filePath, sessionId: entry.slice(0, -'.jsonl'.length), mtimeMs: st.mtimeMs });
      } catch {
        continue;
      }
    }
  }
  return files;
}

async function readTail(path: string, size: number, tailBytes: number): Promise<string> {
  const len = Math.min(size, tailBytes);
  if (len === 0) return '';
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

interface SessionMatch {
  sessionId: string;
  snippets: TranscriptSnippetHit[];
}

async function scanTranscripts(
  terms: string[],
  config: HubConfig,
  log: Logger,
  projectsDir: string
): Promise<SessionMatch[]> {
  if (terms.length === 0) return [];

  const sinceMs = Date.now() - config.overlord.transcriptDays * DAY_MS;
  const tailBytes = config.overlord.tailKb * 1024;

  const files = await listTranscriptFiles(projectsDir, sinceMs, log);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first

  const results: SessionMatch[] = [];
  let overallCount = 0;

  for (const file of files) {
    if (overallCount >= MAX_SNIPPETS_OVERALL) break;
    let tail: string;
    try {
      const st = await stat(file.path);
      tail = await readTail(file.path, st.size, tailBytes);
    } catch (err) {
      log.debug('overlord: failed to read transcript', {
        path: file.path,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    const remaining = MAX_SNIPPETS_OVERALL - overallCount;
    const perSessionCap = Math.min(MAX_SNIPPETS_PER_SESSION, remaining);
    const snippets = extractSnippets(tail, terms, perSessionCap);
    if (snippets.length === 0) continue;

    results.push({ sessionId: file.sessionId, snippets });
    overallCount += snippets.length;
  }

  return results;
}

// One prepared statement, reused per term (not one big OR'd query) — messages are low-volume, so a
// query per term is cheap, and it keeps each LIKE match independently capped.
function searchMessages(db: Database.Database, terms: string[]): MessageRow[] {
  if (terms.length === 0) return [];
  const query = db.prepare(
    `SELECT * FROM messages WHERE body LIKE ? COLLATE NOCASE ORDER BY created_at DESC LIMIT ${MAX_MESSAGE_ROWS_PER_TERM}`
  );
  const byId = new Map<number, MessageRow>();
  for (const term of terms) {
    const rows = query.all(`%${term}%`) as MessageRow[];
    for (const row of rows) if (!byId.has(row.id)) byId.set(row.id, row);
  }
  return [...byId.values()].sort((a, b) => b.created_at - a.created_at);
}

export interface OverlordCandidate {
  sessionId: string;
  instance_name: string | null;
  cwd: string;
  status: string;
  last_event_at: number | null;
  snippets: string[];
}

function bestSnippetTimestamp(snippets: TranscriptSnippetHit[]): number | null {
  let max: number | null = null;
  for (const s of snippets) {
    if (s.timestampMs === null) continue;
    if (max === null || s.timestampMs > max) max = s.timestampMs;
  }
  return max;
}

function buildCandidates(db: Database.Database, matches: SessionMatch[]): OverlordCandidate[] {
  return matches.map((m) => {
    const session = sessionsRepo.getJoined(db, m.sessionId);
    const cwd = session?.cwd ?? m.snippets.find((s) => s.cwd)?.cwd ?? '';
    return {
      sessionId: m.sessionId,
      instance_name: session?.instance_name ?? null,
      cwd,
      status: session?.status ?? 'unknown',
      last_event_at: session?.last_event_at ?? bestSnippetTimestamp(m.snippets),
      snippets: m.snippets.map((s) => s.snippet),
    };
  });
}

function formatCandidatesForPrompt(candidates: OverlordCandidate[]): string {
  if (candidates.length === 0) return '(no candidate sessions found)';
  return candidates
    .map((c, i) => {
      const id8 = c.sessionId.slice(0, 8);
      const folder = c.cwd || 'unknown';
      const lastActivity = c.last_event_at ? new Date(c.last_event_at).toISOString() : 'unknown';
      const snippetLines = c.snippets
        .slice(0, MAX_CANDIDATE_SNIPPETS_IN_PROMPT)
        .map((s) => `  - ${clip(s, CANDIDATE_SNIPPET_CLIP)}`)
        .join('\n');
      return `[${i + 1}] id=${id8} folder=${folder} last_activity=${lastActivity} status=${c.status}\n${snippetLines}`;
    })
    .join('\n\n');
}

function formatMessagesForPrompt(messages: MessageRow[]): string {
  if (messages.length === 0) return '';
  const lines = messages
    .slice(0, 10)
    .map((m) => `  - ${m.from_name} -> ${m.to_name ?? 'broadcast'}: ${clip(m.body, CANDIDATE_SNIPPET_CLIP)}`)
    .join('\n');
  return `\n\nRelated inter-agent chat messages:\n${lines}`;
}

// --- Digest mode: scoped "summarize recent activity" questions (pure Node, no AI until Stage 3) ---

// Minimal shape filterSessionsByScope needs — kept separate from SessionJoined so unit tests can
// pass small fixtures instead of a full session row. A real SessionJoined satisfies this structurally.
export interface ScopeSessionLike {
  instance_name: string | null;
  cwd: string;
  last_event_at: number;
}

// Matches a digest scope (e.g. "wonkybox") against each session's instance name OR cwd,
// case-insensitively, newest-first, capped. Sessions of any status (including 'ended') are eligible
// — the caller passes the unfiltered session list.
export function filterSessionsByScope<T extends ScopeSessionLike>(
  sessions: T[],
  scope: string,
  limit: number = DIGEST_SESSION_CAP
): T[] {
  const needle = scope.trim().toLowerCase();
  if (!needle) return [];
  return sessions
    .filter((s) => (s.instance_name ?? '').toLowerCase().includes(needle) || s.cwd.toLowerCase().includes(needle))
    .sort((a, b) => b.last_event_at - a.last_event_at)
    .slice(0, limit);
}

interface DigestSessionData {
  session: SessionJoined;
  entries: string[];
}

async function loadDigestEntries(session: SessionJoined, tailBytes: number, log: Logger): Promise<string[]> {
  if (!session.transcript_path) return [];
  try {
    const st = await stat(session.transcript_path);
    const tail = await readTail(session.transcript_path, st.size, tailBytes);
    return extractDigestEntries(tail);
  } catch (err) {
    log.debug('overlord: failed to read transcript for digest', {
      path: session.transcript_path,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function buildDigestData(
  sessions: SessionJoined[],
  config: HubConfig,
  log: Logger
): Promise<DigestSessionData[]> {
  const tailBytes = config.overlord.tailKb * 1024;
  return Promise.all(sessions.map(async (session) => ({ session, entries: await loadDigestEntries(session, tailBytes, log) })));
}

// Result-shape parity with find mode: candidates keep only the last 3 entries as "snippets" so the
// admin page's existing cards/resume-command/cited-first rendering works untouched. The richer
// (up to 25-entry) transcript is only used for the Stage 3 prompt (formatDigestForPrompt below).
function buildDigestCandidates(data: DigestSessionData[]): OverlordCandidate[] {
  return data.map(({ session, entries }) => ({
    sessionId: session.id,
    instance_name: session.instance_name,
    cwd: session.cwd,
    status: session.status,
    last_event_at: session.last_event_at,
    snippets: entries.slice(-DIGEST_CARD_SNIPPETS),
  }));
}

function formatDigestForPrompt(data: DigestSessionData[], capped: boolean): string {
  if (data.length === 0) return '(no candidate sessions found)';
  const body = data
    .map(({ session, entries }, i) => {
      const id8 = session.id.slice(0, 8);
      const folder = session.cwd || 'unknown';
      const instance = session.instance_name ?? 'unknown';
      const lastActivity = session.last_event_at ? new Date(session.last_event_at).toISOString() : 'unknown';
      const entryLines =
        entries.length > 0 ? entries.map((e) => `  - ${e}`).join('\n') : '  (no readable transcript)';
      return (
        `[${i + 1}] id=${id8} instance=${instance} folder=${folder} status=${session.status} ` +
        `last_activity=${lastActivity}\n${entryLines}`
      );
    })
    .join('\n\n');
  const note = capped
    ? `\n\n(Only the ${data.length} most recent sessions in scope are shown — older sessions may have been omitted.)`
    : '';
  return body + note;
}

// find/digest result shape, unchanged from before ask mode existed. `mode` is optional here (and
// only ever 'find'|'digest' when set) purely so the discriminated OverlordResult union below can
// tell it apart from OverlordAskResult — existing callers that never set `mode` are unaffected.
export interface OverlordFindResult {
  mode?: 'find' | 'digest';
  answer: string;
  candidates: OverlordCandidate[];
}

export interface OverlordAskTarget {
  name: string;
  cwd: string;
}

// Ask mode's result: no answer/candidates yet — nothing has been sent. The admin route renders a
// confirmation (message + target list + excluded list) and only actually sends on a second,
// explicit POST (see POST /api/v1/admin/overlord-send in apiRoutes.ts). `excluded` is the non-live
// scope matches skipped by default (see resolveAskTargets/partitionAskTargets) — always [] when
// the question's includeInactive flag was true.
export interface OverlordAskResult {
  mode: 'ask';
  message: string;
  targets: OverlordAskTarget[];
  excluded: OverlordAskTarget[];
}

// Dispatch mode's result: a plan, not an outcome — nothing has been injected or spawned yet. The
// admin route renders a confirmation (renderOverlordDispatchConfirm) and only actually executes it
// on a second, explicit POST (see POST /api/v1/admin/overlord-dispatch in apiRoutes.ts). `action`
// is the SAME DispatchAction shape src/spawn/dispatcher.ts consumes, so the confirm route can
// round-trip it through hidden form fields without re-deriving it.
export interface OverlordDispatchResult {
  mode: 'dispatch';
  task: string;
  name: string;
  action: DispatchAction;
  candidates: DispatchCandidate[];
}

export type OverlordResult = OverlordFindResult | OverlordAskResult | OverlordDispatchResult;

// resolveDispatchPlan's return shape — null when no known instance matches the scope at all (the
// caller falls back to find mode in that case, same pattern as runDigest's zero-match fallback).
export interface OverlordDispatchPlan {
  action: DispatchAction;
  task: string;
  candidates: DispatchCandidate[];
}

export interface OverlordIo {
  fetchFn?: typeof fetch;
  // Override the transcripts root dir (tests). Defaults to ~/.claude/projects.
  projectsDir?: string;
}

export interface OverlordDeps {
  db: Database.Database;
  config: HubConfig;
  log: Logger;
  io?: OverlordIo;
  // Ask-mode liveness check: true when `cwd` has an open cc-attach terminal or a mid-turn
  // session. Anything else would only ever be reached via a fresh headless spawn — see
  // resolveAskTargets. Required (not optional) so every caller/test makes its liveness policy
  // explicit rather than silently defaulting.
  isLiveInstance: (cwd: string) => boolean;
  // Dispatch-mode liveness: for a given instance (cwd + resolved name), whether a cc-attach
  // wrapper is currently attached and whether it's actively working right now — see
  // src/spawn/dispatcher.ts's decideDispatch, which only reuses an attached-and-idle candidate.
  // Wired in src/index.ts from attach.getByName(name) ?? attach.get(cwd) (attached) and
  // attach.isWorking(cwd) (working). Required, same reasoning as isLiveInstance above.
  getInstanceLiveness: (cwd: string, name: string) => { attached: boolean; working: boolean };
}

export interface Overlord {
  ask(question: string): Promise<OverlordResult>;
  // Exposed separately (not just an ask() implementation detail) so tests can exercise target
  // resolution without a full ask() round-trip. Pure lookup, no side effects.
  resolveAskTargets(scope: string | null, includeInactive: boolean): AskTargetPartition<OverlordAskTarget>;
  // Exposed separately for the same reason as resolveAskTargets above. Pure lookup (DB read +
  // getInstanceLiveness calls), no side effects — nothing is injected or spawned here.
  resolveDispatchPlan(scope: string, task: string, name: string): OverlordDispatchPlan | null;
}

// --- Ask mode: "tell/ask the live agents something" (pure Node, no AI until Stage 1's classify) ---

// Minimal shape filterInstancesByScope needs — a real InstanceRow satisfies this structurally.
export interface AskInstanceLike {
  name: string;
  cwd: string;
}

// Matches an ask-mode scope (e.g. "wonkybox") against each instance's name OR cwd,
// case-insensitively, capped. A null/blank scope selects every known instance ("ask everyone") —
// instances carry no activity column to rank by, so the order is whatever the caller passed in
// (instancesRepo.list's own alphabetical-by-name order).
export function filterInstancesByScope<T extends AskInstanceLike>(
  instances: T[],
  scope: string | null,
  limit: number = ASK_TARGET_CAP
): T[] {
  const needle = (scope ?? '').trim().toLowerCase();
  if (!needle) return instances.slice(0, limit);
  return instances
    .filter((i) => i.name.toLowerCase().includes(needle) || i.cwd.toLowerCase().includes(needle))
    .slice(0, limit);
}

export interface AskTargetPartition<T> {
  targets: T[];
  excluded: T[];
}

// Splits scope-matched instances into reachable targets vs. skipped-because-inactive, via the
// caller-supplied liveness predicate (isLiveInstance — an attached terminal or a mid-turn
// session; see src/index.ts's wiring). `includeInactive` (from Stage 1's classification) is the
// explicit opt-out: when true, every match is a target (live ones first, so a live instance is
// never bumped out of the cap by a dead one) and nothing is reported excluded; when false
// (the default), only live matches become targets and the rest are surfaced as `excluded` so the
// confirmation UI can tell the human what got skipped and why.
export function partitionAskTargets<T extends AskInstanceLike>(
  matches: T[],
  isLiveInstance: (cwd: string) => boolean,
  includeInactive: boolean,
  targetCap: number = ASK_TARGET_CAP,
  excludedCap: number = ASK_EXCLUDED_DISPLAY_CAP
): AskTargetPartition<T> {
  const live = matches.filter((m) => isLiveInstance(m.cwd));
  const dead = matches.filter((m) => !isLiveInstance(m.cwd));
  if (includeInactive) {
    return { targets: [...live, ...dead].slice(0, targetCap), excluded: [] };
  }
  return { targets: live.slice(0, targetCap), excluded: dead.slice(0, excludedCap) };
}

// Find mode (the original behavior): keyword-scan transcripts + messages for `terms`, then compose
// an answer citing the resulting candidates. Also used as digest mode's fallback when its scope
// matches zero known sessions.
async function runFind(
  question: string,
  terms: string[],
  db: Database.Database,
  config: HubConfig,
  log: Logger,
  fetchFn: typeof fetch,
  projectsDir: string
): Promise<OverlordFindResult> {
  log.info('overlord: find mode', { terms });

  const [matches, messageHits] = await Promise.all([
    scanTranscripts(terms, config, log, projectsDir).catch((err: unknown) => {
      log.debug('overlord: transcript scan failed', { error: err instanceof Error ? err.message : String(err) });
      return [] as SessionMatch[];
    }),
    Promise.resolve().then(() => {
      try {
        return searchMessages(db, terms);
      } catch (err) {
        log.debug('overlord: message search failed', { error: err instanceof Error ? err.message : String(err) });
        return [] as MessageRow[];
      }
    }),
  ]);

  const candidates = buildCandidates(db, matches)
    .sort((a, b) => (b.last_event_at ?? 0) - (a.last_event_at ?? 0))
    .slice(0, MAX_RESULT_CANDIDATES);

  const userContent =
    `Question: ${question}\n\nCandidate sessions:\n${formatCandidatesForPrompt(candidates)}` +
    formatMessagesForPrompt(messageHits);

  const answer = await callAnswerModel(question, userContent, config, log, fetchFn);

  return { answer, candidates };
}

// Digest mode: scope selected directly from the DB (see filterSessionsByScope) rather than keyword
// retrieval — a generic search term can match unrelated projects and miss the scoped sessions
// entirely, which is exactly the failure mode digest mode exists to avoid. Falls back to find mode
// (scope as an extra term) when the scope matches nothing.
async function runDigest(
  question: string,
  scope: string,
  db: Database.Database,
  config: HubConfig,
  log: Logger,
  fetchFn: typeof fetch,
  projectsDir: string
): Promise<OverlordFindResult> {
  const allSessions = sessionsRepo.listJoined(db);
  const matched = filterSessionsByScope(allSessions, scope, DIGEST_SESSION_CAP);

  if (matched.length === 0) {
    log.info('overlord: digest mode found no sessions, falling back to find', { scope });
    const fallbackTermsList = Array.from(new Set([scope.toLowerCase(), ...fallbackTerms(question)])).slice(
      0,
      MAX_TERMS
    );
    return runFind(question, fallbackTermsList, db, config, log, fetchFn, projectsDir);
  }

  log.info('overlord: digest mode', { scope, sessions: matched.length });

  const data = await buildDigestData(matched, config, log);
  const candidates = buildDigestCandidates(data);
  const capped = matched.length >= DIGEST_SESSION_CAP;

  const userContent = `Question: ${question}\n\nSessions in scope "${scope}":\n${formatDigestForPrompt(data, capped)}`;
  const answer = await callAnswerModel(question, userContent, config, log, fetchFn, DIGEST_ANSWER_SYSTEM_PROMPT);

  return { answer, candidates };
}

export function createOverlord(deps: OverlordDeps): Overlord {
  const { db, config, log, isLiveInstance, getInstanceLiveness } = deps;
  const fetchFn = deps.io?.fetchFn ?? fetch;
  const projectsDir = deps.io?.projectsDir ?? join(homedir(), '.claude', 'projects');

  // Scope-matches every known instance (uncapped — the cap is applied per-bucket below, after
  // partitioning, so a run of dead scope matches can't crowd live ones out of consideration)
  // then splits into reachable targets vs. skipped-inactive via partitionAskTargets.
  function resolveAskTargets(
    scope: string | null,
    includeInactive: boolean
  ): AskTargetPartition<OverlordAskTarget> {
    const instances = instancesRepo.list(db).map((i) => ({ name: i.name, cwd: i.cwd }));
    const matches = filterInstancesByScope(instances, scope, Number.POSITIVE_INFINITY);
    return partitionAskTargets(matches, isLiveInstance, includeInactive);
  }

  // Scope-matches every known instance (uncapped, same reasoning as resolveAskTargets), ordered
  // most-recently-active first (instances.last_seen_at) since that's the only recency signal an
  // instance row carries, then decorates each with liveness and asks decideDispatch to choose
  // between reusing the best idle candidate or opening a fresh tab. Null when scope matches
  // nothing known — the caller (ask() below) falls back to find mode in that case.
  function resolveDispatchPlan(scope: string, task: string, name: string): OverlordDispatchPlan | null {
    const allInstances = instancesRepo.list(db);
    const matched = filterInstancesByScope(allInstances, scope, Number.POSITIVE_INFINITY);
    if (matched.length === 0) return null;

    const ordered = [...matched].sort((a, b) => b.last_seen_at - a.last_seen_at);
    const candidates: DispatchCandidate[] = ordered.map((inst) => {
      const liveness = getInstanceLiveness(inst.cwd, inst.name);
      return { name: inst.name, cwd: inst.cwd, attached: liveness.attached, working: liveness.working };
    });

    const fallbackCwd = candidates[0].cwd;
    const action = decideDispatch(candidates, name, fallbackCwd);
    return { action, task, candidates };
  }

  async function ask(question: string): Promise<OverlordResult> {
    const classification = await classifyQuestion(question, config, log, fetchFn);

    if (classification.mode === 'ask' && classification.message) {
      const includeInactive = classification.includeInactive ?? false;
      const { targets, excluded } = resolveAskTargets(classification.scope, includeInactive);
      log.info('overlord: ask mode', {
        scope: classification.scope,
        includeInactive,
        targets: targets.length,
        excluded: excluded.length,
      });
      return { mode: 'ask', message: classification.message, targets, excluded };
    }

    if (classification.mode === 'dispatch' && classification.scope && classification.task && classification.name) {
      const { scope, task, name } = classification;
      const plan = resolveDispatchPlan(scope, task, name);
      if (!plan) {
        log.info('overlord: dispatch mode found no matching instance, falling back to find', { scope });
        const fallbackTermsList = Array.from(new Set([scope.toLowerCase(), ...fallbackTerms(question)])).slice(
          0,
          MAX_TERMS
        );
        return runFind(question, fallbackTermsList, db, config, log, fetchFn, projectsDir);
      }
      log.info('overlord: dispatch mode', { scope, action: plan.action.kind, name });
      return { mode: 'dispatch', task: plan.task, name, action: plan.action, candidates: plan.candidates };
    }

    if (classification.mode === 'digest' && classification.scope) {
      return runDigest(question, classification.scope, db, config, log, fetchFn, projectsDir);
    }

    return runFind(question, classification.terms, db, config, log, fetchFn, projectsDir);
  }

  return { ask, resolveAskTargets, resolveDispatchPlan };
}
