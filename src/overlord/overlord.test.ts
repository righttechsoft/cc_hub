import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrations.js';
import * as instancesRepo from '../db/repo/instances.js';
import type { HubConfig, Logger } from '../types.js';
import {
  createOverlord,
  extractDigestEntries,
  extractSnippets,
  fallbackTerms,
  filterInstancesByScope,
  filterSessionsByScope,
  normalizeDispatchName,
  partitionAskTargets,
  parseStage1Response,
  parseTermsResponse,
} from './overlord.js';

describe('fallbackTerms', () => {
  it('extracts words >= 4 chars, drops stopwords, caps at 8', () => {
    const q = 'find a session where I fixed the date bug in the meeting calendar widget component today';
    const terms = fallbackTerms(q);
    expect(terms.length).toBeLessThanOrEqual(8);
    expect(terms).toContain('fixed');
    expect(terms).toContain('date');
    expect(terms).toContain('meeting');
    expect(terms).toContain('calendar');
    expect(terms).not.toContain('find'); // stopword
    expect(terms).not.toContain('the'); // too short
    expect(terms).not.toContain('bug'); // too short (3 chars)
  });

  it('dedupes repeated words', () => {
    const terms = fallbackTerms('date date date fixed fixed');
    expect(terms.filter((t) => t === 'date').length).toBe(1);
  });

  it('caps at 8 terms even with many candidate words', () => {
    const q = Array.from({ length: 20 }, (_, i) => `word${i}long`).join(' ');
    expect(fallbackTerms(q).length).toBe(8);
  });

  it('returns an empty array when nothing survives the filter', () => {
    expect(fallbackTerms('the a is it to be or')).toEqual([]);
  });
});

describe('parseTermsResponse', () => {
  it('accepts a valid JSON array of strings', () => {
    const terms = parseTermsResponse('["date bug", "meeting card"]', 'irrelevant question here');
    expect(terms).toEqual(['date bug', 'meeting card']);
  });

  it('falls back to the question words on garbage input', () => {
    const question = 'fix the date bug please';
    expect(parseTermsResponse('not json at all', question)).toEqual(fallbackTerms(question));
  });

  it('salvages an array wrapped in a markdown fence', () => {
    const terms = parseTermsResponse('```json\n["foo", "bar"]\n```', 'question');
    expect(terms).toEqual(['foo', 'bar']);
  });

  it('falls back when array elements are not all strings', () => {
    const question = 'fix the date bug please';
    expect(parseTermsResponse('[1, 2, 3]', question)).toEqual(fallbackTerms(question));
  });

  it('falls back on an empty array', () => {
    const question = 'fix the date bug please';
    expect(parseTermsResponse('[]', question)).toEqual(fallbackTerms(question));
  });

  it('caps at 8 terms', () => {
    const arr = Array.from({ length: 12 }, (_, i) => `term${i}`);
    expect(parseTermsResponse(JSON.stringify(arr), 'q').length).toBe(8);
  });

  it('lowercases and trims returned terms', () => {
    expect(parseTermsResponse('["  Date BUG  "]', 'q')).toEqual(['date bug']);
  });
});

describe('extractSnippets', () => {
  function transcriptLine(
    type: 'user' | 'assistant',
    text: string,
    extra: { timestamp?: string; cwd?: string; isSidechain?: boolean; isMeta?: boolean } = {}
  ): string {
    return JSON.stringify({
      type,
      timestamp: extra.timestamp ?? '2026-01-01T00:00:00.000Z',
      cwd: extra.cwd ?? '/proj',
      isSidechain: extra.isSidechain,
      isMeta: extra.isMeta,
      message: { content: [{ type: 'text', text }] },
    });
  }

  it('extracts a +/-200 char window around the first term hit', () => {
    const longText = 'x'.repeat(300) + ' the date bug is here ' + 'y'.repeat(300);
    const hits = extractSnippets(transcriptLine('assistant', longText), ['date bug']);
    expect(hits.length).toBe(1);
    expect(hits[0].snippet).toContain('date bug');
    expect(hits[0].snippet.length).toBeLessThan(longText.length);
    expect(hits[0].snippet.startsWith('…')).toBe(true);
    expect(hits[0].snippet.endsWith('…')).toBe(true);
  });

  it('does not prefix/suffix an ellipsis when the match is near the text edges', () => {
    const hits = extractSnippets(transcriptLine('user', 'the date bug'), ['date bug']);
    expect(hits[0].snippet).toBe('the date bug');
  });

  it('captures timestamp and cwd when present', () => {
    const hits = extractSnippets(
      transcriptLine('user', 'please fix the date bug', { timestamp: '2026-02-03T04:05:06.000Z', cwd: '/rts/proj' }),
      ['date bug']
    );
    expect(hits[0].timestampMs).toBe(Date.parse('2026-02-03T04:05:06.000Z'));
    expect(hits[0].cwd).toBe('/rts/proj');
  });

  it('respects the per-session cap (maxSnippets)', () => {
    const lines = Array.from({ length: 20 }, (_, i) => transcriptLine('user', `bug number ${i}`)).join('\n');
    const hits = extractSnippets(lines, ['bug'], 3);
    expect(hits.length).toBe(3);
  });

  it('defaults to a cap of 8 when maxSnippets is omitted', () => {
    const lines = Array.from({ length: 20 }, (_, i) => transcriptLine('user', `bug number ${i}`)).join('\n');
    expect(extractSnippets(lines, ['bug']).length).toBe(8);
  });

  it('is case-insensitive', () => {
    expect(extractSnippets(transcriptLine('assistant', 'Fixed the DATE BUG today'), ['date bug']).length).toBe(1);
  });

  it('skips unparseable lines without throwing', () => {
    const buffer = 'not json{{{\n' + transcriptLine('user', 'the date bug story');
    expect(extractSnippets(buffer, ['date bug']).length).toBe(1);
  });

  it('skips sidechain and meta lines', () => {
    const sidechain = transcriptLine('user', 'the date bug', { isSidechain: true });
    const meta = transcriptLine('user', 'the date bug', { isMeta: true });
    expect(extractSnippets(sidechain, ['date bug'])).toEqual([]);
    expect(extractSnippets(meta, ['date bug'])).toEqual([]);
  });

  it('returns an empty array when terms is empty', () => {
    expect(extractSnippets('anything the date bug', [])).toEqual([]);
  });

  it('returns an empty array when maxSnippets is 0', () => {
    expect(extractSnippets(transcriptLine('user', 'the date bug'), ['date bug'], 0)).toEqual([]);
  });

  it('matches plain string content, not just content-block arrays', () => {
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { content: 'a plain string with the date bug in it' },
    });
    expect(extractSnippets(line, ['date bug']).length).toBe(1);
  });

  it('ignores a raw-line match that does not appear in the extracted text (e.g. a tool_use block)', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { content: [{ type: 'tool_use', name: 'date bug tool', input: {} }] },
    });
    expect(extractSnippets(line, ['date bug'])).toEqual([]);
  });
});

describe('parseStage1Response', () => {
  it('parses the object form with mode digest + scope', () => {
    const result = parseStage1Response('{"mode":"digest","scope":"wonkybox","terms":[]}', 'irrelevant question');
    expect(result).toEqual({ mode: 'digest', scope: 'wonkybox', terms: [] });
  });

  it('parses the object form with mode find + terms', () => {
    const result = parseStage1Response(
      '{"mode":"find","scope":null,"terms":["date bug","meeting card"]}',
      'irrelevant question'
    );
    expect(result).toEqual({ mode: 'find', scope: null, terms: ['date bug', 'meeting card'] });
  });

  it('trims an object-form scope', () => {
    const result = parseStage1Response('{"mode":"digest","scope":"  Wonkybox  "}', 'q');
    expect(result).toEqual({ mode: 'digest', scope: 'Wonkybox', terms: [] });
  });

  it('accepts a bare JSON array (old form) as find mode back-compat', () => {
    const result = parseStage1Response('["date bug", "meeting card"]', 'irrelevant question');
    expect(result).toEqual({ mode: 'find', scope: null, terms: ['date bug', 'meeting card'] });
  });

  it('salvages an object wrapped in a markdown fence', () => {
    const result = parseStage1Response('```json\n{"mode":"digest","scope":"foo","terms":[]}\n```', 'q');
    expect(result).toEqual({ mode: 'digest', scope: 'foo', terms: [] });
  });

  it('salvages a bare array wrapped in a markdown fence', () => {
    const result = parseStage1Response('```json\n["foo", "bar"]\n```', 'q');
    expect(result).toEqual({ mode: 'find', scope: null, terms: ['foo', 'bar'] });
  });

  it('falls back to find + fallback terms on an object with an unrecognized mode', () => {
    const question = 'fix the date bug please';
    const result = parseStage1Response('{"mode":"summarize","scope":"foo"}', question);
    expect(result.mode).toBe('find');
    expect(result.terms).toEqual(fallbackTerms(question));
  });

  it('falls back to find + fallback terms on a digest object with no usable scope', () => {
    const question = 'fix the date bug please';
    const result = parseStage1Response('{"mode":"digest","scope":null,"terms":[]}', question);
    expect(result).toEqual({ mode: 'find', scope: null, terms: fallbackTerms(question) });
  });

  it('falls back to find + fallback terms on garbage input', () => {
    const question = 'fix the date bug please';
    const result = parseStage1Response('not json at all', question);
    expect(result).toEqual({ mode: 'find', scope: null, terms: fallbackTerms(question) });
  });

  it('caps find-mode terms at 8', () => {
    const arr = Array.from({ length: 12 }, (_, i) => `term${i}`);
    const result = parseStage1Response(JSON.stringify({ mode: 'find', terms: arr }), 'q');
    expect(result.terms.length).toBe(8);
  });

  it('parses the object form with mode ask + scope + message', () => {
    const result = parseStage1Response(
      '{"mode":"ask","scope":"wonkybox","message":"What is blocking you?"}',
      'irrelevant question'
    );
    expect(result).toEqual({
      mode: 'ask',
      scope: 'wonkybox',
      terms: [],
      message: 'What is blocking you?',
      includeInactive: false,
    });
  });

  it('parses mode ask with a null scope (ask everyone)', () => {
    const result = parseStage1Response('{"mode":"ask","scope":null,"message":"Push your branch."}', 'q');
    expect(result).toEqual({ mode: 'ask', scope: null, terms: [], message: 'Push your branch.', includeInactive: false });
  });

  it('trims an ask-mode message and scope', () => {
    const result = parseStage1Response('{"mode":"ask","scope":"  foo  ","message":"  do it  "}', 'q');
    expect(result).toEqual({ mode: 'ask', scope: 'foo', terms: [], message: 'do it', includeInactive: false });
  });

  it('parses includeInactive:true on an ask object', () => {
    const result = parseStage1Response(
      '{"mode":"ask","scope":"wonkybox","includeInactive":true,"message":"Push your branch."}',
      'q'
    );
    expect(result).toEqual({
      mode: 'ask',
      scope: 'wonkybox',
      terms: [],
      message: 'Push your branch.',
      includeInactive: true,
    });
  });

  it('defaults includeInactive to false when absent from an ask object', () => {
    const result = parseStage1Response('{"mode":"ask","scope":null,"message":"hi"}', 'q');
    expect(result.includeInactive).toBe(false);
  });

  it('falls back to find + fallback terms on an ask object with an empty message', () => {
    const question = 'fix the date bug please';
    const result = parseStage1Response('{"mode":"ask","scope":"foo","message":""}', question);
    expect(result).toEqual({ mode: 'find', scope: null, terms: fallbackTerms(question) });
  });

  it('falls back to find + fallback terms on an ask object with no message field at all', () => {
    const question = 'fix the date bug please';
    const result = parseStage1Response('{"mode":"ask","scope":"foo"}', question);
    expect(result).toEqual({ mode: 'find', scope: null, terms: fallbackTerms(question) });
  });

  it('salvages an ask object wrapped in a markdown fence', () => {
    const result = parseStage1Response('```json\n{"mode":"ask","scope":null,"message":"hi"}\n```', 'q');
    expect(result).toEqual({ mode: 'ask', scope: null, terms: [], message: 'hi', includeInactive: false });
  });

  it('parses the object form with mode dispatch + scope + task + name', () => {
    const result = parseStage1Response(
      '{"mode":"dispatch","scope":"wonkybox2_api","task":"Implement the CSV export.","name":"csv-export"}',
      'irrelevant question'
    );
    expect(result).toEqual({
      mode: 'dispatch',
      scope: 'wonkybox2_api',
      terms: [],
      task: 'Implement the CSV export.',
      name: 'csv-export',
    });
  });

  it('trims a dispatch-mode scope and task', () => {
    const result = parseStage1Response(
      '{"mode":"dispatch","scope":"  wonkybox  ","task":"  fix it  ","name":"fix-it"}',
      'q'
    );
    expect(result.scope).toBe('wonkybox');
    expect(result.task).toBe('fix it');
  });

  it('normalizes a dispatch-mode name (uppercase, spaces)', () => {
    const result = parseStage1Response(
      '{"mode":"dispatch","scope":"wonkybox","task":"fix it","name":"Fix The Bug"}',
      'q'
    );
    expect(result.name).toBe('fix-the-bug');
  });

  it('derives a dispatch-mode name from the task when name is missing', () => {
    const result = parseStage1Response('{"mode":"dispatch","scope":"wonkybox","task":"fix the bug"}', 'q');
    expect(result.mode).toBe('dispatch');
    expect(result.name).toBe('fix-the-bug');
  });

  it('falls back to find + fallback terms on a dispatch object with an empty scope', () => {
    const question = 'fix the date bug please';
    const result = parseStage1Response('{"mode":"dispatch","scope":"","task":"fix it","name":"fix-it"}', question);
    expect(result).toEqual({ mode: 'find', scope: null, terms: fallbackTerms(question) });
  });

  it('falls back to find + fallback terms on a dispatch object with an empty task', () => {
    const question = 'fix the date bug please';
    const result = parseStage1Response('{"mode":"dispatch","scope":"wonkybox","task":""}', question);
    expect(result).toEqual({ mode: 'find', scope: null, terms: fallbackTerms(question) });
  });

  it('salvages a dispatch object wrapped in a markdown fence', () => {
    const result = parseStage1Response(
      '```json\n{"mode":"dispatch","scope":"wonkybox","task":"fix it","name":"fix-it"}\n```',
      'q'
    );
    expect(result).toEqual({ mode: 'dispatch', scope: 'wonkybox', terms: [], task: 'fix it', name: 'fix-it' });
  });
});

describe('normalizeDispatchName', () => {
  it('lowercases and keeps a valid kebab-case name as-is', () => {
    expect(normalizeDispatchName('fix-csv-export')).toBe('fix-csv-export');
    expect(normalizeDispatchName('Fix-CSV-Export')).toBe('fix-csv-export');
  });

  it('replaces non-conforming characters with a hyphen', () => {
    expect(normalizeDispatchName('fix the bug!!')).toBe('fix-the-bug--');
  });

  it('truncates to 40 characters', () => {
    const long = 'a'.repeat(60);
    expect(normalizeDispatchName(long).length).toBe(40);
  });

  it('falls back to "task" for an empty string', () => {
    expect(normalizeDispatchName('')).toBe('task');
    expect(normalizeDispatchName('   ')).toBe('task');
  });

  it('falls back to "task" when nothing survives normalization into a valid leading character', () => {
    expect(normalizeDispatchName('---')).toBe('task');
  });
});

describe('filterSessionsByScope', () => {
  function session(overrides: { instance_name?: string | null; cwd?: string; last_event_at?: number }) {
    return {
      instance_name: overrides.instance_name ?? null,
      cwd: overrides.cwd ?? '/proj',
      last_event_at: overrides.last_event_at ?? 0,
    };
  }

  it('matches on instance name, case-insensitively', () => {
    const sessions = [session({ instance_name: 'WonkyBox', cwd: '/x' })];
    expect(filterSessionsByScope(sessions, 'wonkybox')).toEqual(sessions);
  });

  it('matches on cwd, case-insensitively', () => {
    const sessions = [session({ instance_name: null, cwd: '/rts/WonkyBox' })];
    expect(filterSessionsByScope(sessions, 'wonkybox')).toEqual(sessions);
  });

  it('excludes sessions matching neither instance name nor cwd', () => {
    const sessions = [session({ instance_name: 'other', cwd: '/other' })];
    expect(filterSessionsByScope(sessions, 'wonkybox')).toEqual([]);
  });

  it('orders results by last_event_at descending', () => {
    const older = session({ instance_name: 'wonkybox', last_event_at: 100 });
    const newer = session({ instance_name: 'wonkybox', last_event_at: 200 });
    expect(filterSessionsByScope([older, newer], 'wonkybox')).toEqual([newer, older]);
  });

  it('honors the cap', () => {
    const sessions = Array.from({ length: 10 }, (_, i) => session({ instance_name: 'wonkybox', last_event_at: i }));
    expect(filterSessionsByScope(sessions, 'wonkybox', 6).length).toBe(6);
  });

  it('returns the 6 most recent when capped', () => {
    const sessions = Array.from({ length: 10 }, (_, i) => session({ instance_name: 'wonkybox', last_event_at: i }));
    const result = filterSessionsByScope(sessions, 'wonkybox', 6);
    expect(result.map((s) => s.last_event_at)).toEqual([9, 8, 7, 6, 5, 4]);
  });

  it('returns an empty array for a blank scope', () => {
    expect(filterSessionsByScope([session({ instance_name: 'wonkybox' })], '   ')).toEqual([]);
  });
});

describe('filterInstancesByScope', () => {
  function instance(overrides: { name?: string; cwd?: string } = {}) {
    return { name: overrides.name ?? 'alpha', cwd: overrides.cwd ?? '/proj/alpha' };
  }

  it('matches on instance name, case-insensitively', () => {
    const instances = [instance({ name: 'WonkyBox', cwd: '/x' })];
    expect(filterInstancesByScope(instances, 'wonkybox')).toEqual(instances);
  });

  it('matches on cwd, case-insensitively', () => {
    const instances = [instance({ name: 'other', cwd: '/rts/WonkyBox' })];
    expect(filterInstancesByScope(instances, 'wonkybox')).toEqual(instances);
  });

  it('excludes instances matching neither name nor cwd', () => {
    const instances = [instance({ name: 'other', cwd: '/other' })];
    expect(filterInstancesByScope(instances, 'wonkybox')).toEqual([]);
  });

  it('a null scope selects all instances', () => {
    const instances = [instance({ name: 'alpha' }), instance({ name: 'beta', cwd: '/proj/beta' })];
    expect(filterInstancesByScope(instances, null)).toEqual(instances);
  });

  it('a blank scope selects all instances', () => {
    const instances = [instance({ name: 'alpha' }), instance({ name: 'beta', cwd: '/proj/beta' })];
    expect(filterInstancesByScope(instances, '   ')).toEqual(instances);
  });

  it('honors the cap, including for a null scope', () => {
    const instances = Array.from({ length: 10 }, (_, i) => instance({ name: `i${i}`, cwd: `/p${i}` }));
    expect(filterInstancesByScope(instances, null, 8).length).toBe(8);
    expect(filterInstancesByScope(instances, 'i', 8).length).toBe(8);
  });

  it('defaults the cap to 8', () => {
    const instances = Array.from({ length: 10 }, (_, i) => instance({ name: `i${i}`, cwd: `/p${i}` }));
    expect(filterInstancesByScope(instances, null).length).toBe(8);
  });
});

describe('partitionAskTargets', () => {
  function instance(name: string) {
    return { name, cwd: `/proj/${name}` };
  }

  function liveSet(names: string[]): (cwd: string) => boolean {
    const set = new Set(names.map((n) => `/proj/${n}`));
    return (cwd) => set.has(cwd);
  }

  it('splits into live targets and dead excluded when includeInactive is false', () => {
    const matches = [instance('alpha'), instance('beta'), instance('gamma')];
    const result = partitionAskTargets(matches, liveSet(['alpha', 'gamma']), false);
    expect(result.targets).toEqual([instance('alpha'), instance('gamma')]);
    expect(result.excluded).toEqual([instance('beta')]);
  });

  it('caps targets at 8 (live matches only)', () => {
    const matches = Array.from({ length: 12 }, (_, i) => instance(`i${i}`));
    const result = partitionAskTargets(matches, () => true, false);
    expect(result.targets.length).toBe(8);
    expect(result.excluded).toEqual([]);
  });

  it('caps excluded at 12 for display', () => {
    const matches = Array.from({ length: 20 }, (_, i) => instance(`i${i}`));
    const result = partitionAskTargets(matches, () => false, false);
    expect(result.targets).toEqual([]);
    expect(result.excluded.length).toBe(12);
  });

  it('when includeInactive is true, keeps all matches (capped) with live ones first, and excludes nothing', () => {
    const matches = [instance('deadOne'), instance('alive'), instance('deadTwo')];
    const result = partitionAskTargets(matches, liveSet(['alive']), true);
    expect(result.targets).toEqual([instance('alive'), instance('deadOne'), instance('deadTwo')]);
    expect(result.excluded).toEqual([]);
  });

  it('includeInactive true still respects the target cap', () => {
    const matches = Array.from({ length: 12 }, (_, i) => instance(`i${i}`));
    const result = partitionAskTargets(matches, () => false, true);
    expect(result.targets.length).toBe(8);
    expect(result.excluded).toEqual([]);
  });

  it('returns empty targets and excluded for an empty match list', () => {
    expect(partitionAskTargets([], () => true, false)).toEqual({ targets: [], excluded: [] });
  });
});

describe('extractDigestEntries', () => {
  function transcriptLine(
    type: 'user' | 'assistant',
    text: string,
    extra: { isSidechain?: boolean; isMeta?: boolean } = {}
  ): string {
    return JSON.stringify({
      type,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { content: [{ type: 'text', text }] },
      isSidechain: extra.isSidechain,
      isMeta: extra.isMeta,
    });
  }

  it('role-tags user and assistant entries', () => {
    const lines = [transcriptLine('user', 'please fix this'), transcriptLine('assistant', 'done')].join('\n');
    expect(extractDigestEntries(lines)).toEqual(['user: please fix this', 'assistant: done']);
  });

  it('keeps only the last 25 entries', () => {
    const lines = Array.from({ length: 40 }, (_, i) => transcriptLine('user', `msg ${i}`)).join('\n');
    const entries = extractDigestEntries(lines);
    expect(entries.length).toBe(25);
    expect(entries[0]).toBe('user: msg 15');
    expect(entries[24]).toBe('user: msg 39');
  });

  it('respects a custom maxEntries', () => {
    const lines = Array.from({ length: 10 }, (_, i) => transcriptLine('user', `msg ${i}`)).join('\n');
    expect(extractDigestEntries(lines, 3).length).toBe(3);
  });

  it('clips entries to 300 chars', () => {
    const long = 'x'.repeat(400);
    const entries = extractDigestEntries(transcriptLine('assistant', long));
    expect(entries[0].length).toBeLessThan(long.length);
    expect(entries[0].endsWith('…')).toBe(true);
  });

  it('skips sidechain and meta lines', () => {
    const lines = [
      transcriptLine('user', 'a', { isSidechain: true }),
      transcriptLine('user', 'b', { isMeta: true }),
    ].join('\n');
    expect(extractDigestEntries(lines)).toEqual([]);
  });

  it('skips unparseable lines and lines with no extractable text', () => {
    const lines = [
      'not json{{{',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'x', input: {} }] } }),
      transcriptLine('user', 'real message'),
    ].join('\n');
    expect(extractDigestEntries(lines)).toEqual(['user: real message']);
  });

  it('returns an empty array for empty input', () => {
    expect(extractDigestEntries('')).toEqual([]);
  });
});

describe('resolveDispatchPlan (via createOverlord)', () => {
  function buildDb(): Database.Database {
    const db = new Database(':memory:');
    runMigrations(db);
    return db;
  }

  function silentLogger(): Logger {
    return { debug() {}, info() {}, warn() {}, error() {} };
  }

  function buildOverlord(
    db: Database.Database,
    getInstanceLiveness: (cwd: string, name: string) => { attached: boolean; working: boolean }
  ) {
    const config = {
      overlord: { enabled: true, model: 'claude-haiku-4-5', transcriptDays: 30, tailKb: 256 },
    } as unknown as HubConfig;
    return createOverlord({ db, config, log: silentLogger(), isLiveInstance: () => false, getInstanceLiveness });
  }

  it('returns null when scope matches no known instance', () => {
    const db = buildDb();
    const overlord = buildOverlord(db, () => ({ attached: false, working: false }));
    expect(overlord.resolveDispatchPlan('nope', 'task', 'name')).toBeNull();
  });

  it('orders candidates most-recently-active first and reuses an idle attached one', () => {
    const db = buildDb();
    instancesRepo.upsert(db, { name: 'wb-old', cwd: '/proj/wb-old', now: 1000 });
    instancesRepo.upsert(db, { name: 'wb-new', cwd: '/proj/wb-new', now: 2000 });

    const overlord = buildOverlord(db, (cwd) => ({ attached: cwd === '/proj/wb-new', working: false }));
    const plan = overlord.resolveDispatchPlan('wb', 'do the task', 'fresh-task');

    expect(plan).not.toBeNull();
    expect(plan!.candidates.map((c) => c.name)).toEqual(['wb-new', 'wb-old']);
    expect(plan!.action).toEqual({ kind: 'inject', name: 'wb-new', cwd: '/proj/wb-new' });
    expect(plan!.task).toBe('do the task');
  });

  it('spawns against the most-recently-active candidate cwd when none are idle-attached', () => {
    const db = buildDb();
    instancesRepo.upsert(db, { name: 'wb-a', cwd: '/proj/wb-a', now: 1000 });
    instancesRepo.upsert(db, { name: 'wb-b', cwd: '/proj/wb-b', now: 2000 });

    const overlord = buildOverlord(db, () => ({ attached: false, working: false }));
    const plan = overlord.resolveDispatchPlan('wb', 'task', 'fresh-task');

    expect(plan!.action).toEqual({ kind: 'spawn', name: 'fresh-task', cwd: '/proj/wb-b' });
  });

  it('skips a working-but-attached candidate in favor of spawning', () => {
    const db = buildDb();
    instancesRepo.upsert(db, { name: 'wb-busy', cwd: '/proj/wb-busy', now: 1000 });

    const overlord = buildOverlord(db, () => ({ attached: true, working: true }));
    const plan = overlord.resolveDispatchPlan('wb', 'task', 'fresh-task');

    expect(plan!.action).toEqual({ kind: 'spawn', name: 'fresh-task', cwd: '/proj/wb-busy' });
  });
});
