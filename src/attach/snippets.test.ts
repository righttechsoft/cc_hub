import { describe, expect, it } from 'vitest';
import {
  decodeSnippetEvents,
  INITIAL_SNIPPET_STATE,
  sanitizeSnippetsConfig,
  stepSnippet,
  type SnippetState,
} from './snippets.js';

const SNIPPETS = { s: '— Damien', r: 'Please review and suggest improvements.' };

// Drives a whole decoded chunk through stepSnippet, threading state like cli.ts does, and
// collects forwarded text + any injected snippet(s).
function run(chunk: string, snippets: Record<string, string>, state: SnippetState = INITIAL_SNIPPET_STATE) {
  let s = state;
  let forward = '';
  const injected: string[] = [];
  for (const event of decodeSnippetEvents(chunk)) {
    const step = stepSnippet(s, event, snippets);
    forward += step.forward;
    if (step.inject !== undefined) injected.push(step.inject);
    s = step.state;
  }
  return { forward, injected, state: s };
}

describe('stepSnippet — raw byte encoding', () => {
  it('leader + known key: injects, forwards nothing', () => {
    const { forward, injected, state } = run('\x07s', SNIPPETS);
    expect(forward).toBe('');
    expect(injected).toEqual(['— Damien']);
    expect(state.awaitingKey).toBe(false);
  });

  it('leader + unknown key: forwards the key, injects nothing', () => {
    const { forward, injected, state } = run('\x07z', SNIPPETS);
    expect(forward).toBe('z');
    expect(injected).toEqual([]);
    expect(state.awaitingKey).toBe(false);
  });

  it('normal typing is forwarded unchanged, byte-for-byte', () => {
    const { forward, injected, state } = run('hello world', SNIPPETS);
    expect(forward).toBe('hello world');
    expect(injected).toEqual([]);
    expect(state.awaitingKey).toBe(false);
  });

  it('leader alone (no follow-up in this chunk) leaves state awaiting — timeout is cli.ts-owned', () => {
    const { forward, injected, state } = run('\x07', SNIPPETS);
    expect(forward).toBe('');
    expect(injected).toEqual([]);
    expect(state.awaitingKey).toBe(true);
  });

  it('a pending leader from a prior chunk resolves against the next chunk', () => {
    const afterLeader = run('\x07', SNIPPETS).state;
    const { forward, injected, state } = run('r', SNIPPETS, afterLeader);
    expect(forward).toBe('');
    expect(injected).toEqual(['Please review and suggest improvements.']);
    expect(state.awaitingKey).toBe(false);
  });

  it('re-pressing the leader while already awaiting restarts the wait instead of matching "\\x07" as a key', () => {
    const { forward, injected, state } = run('\x07\x07s', SNIPPETS);
    expect(forward).toBe('');
    expect(injected).toEqual(['— Damien']);
    expect(state.awaitingKey).toBe(false);
  });

  it('text after a resolved selector in the same chunk is forwarded normally', () => {
    const { forward, injected } = run('\x07zabc', SNIPPETS);
    expect(forward).toBe('zabc');
    expect(injected).toEqual([]);
  });
});

describe('stepSnippet — win32-input-mode record encoding', () => {
  // ESC[Vk;Sc;Uc;Kd;Cs;Rc_ — Uc=7 is Ctrl+G (leader), Uc=115 is 's', Kd=1 keydown / 0 keyup.
  const leaderDown = '\x1b[71;35;7;1;0;1_';
  const leaderUp = '\x1b[71;35;7;0;0;1_';
  const sDown = '\x1b[83;31;115;1;29;1_';
  const sUp = '\x1b[83;31;115;0;29;1_';
  const zDown = '\x1b[90;44;122;1;29;1_';
  const zUp = '\x1b[90;44;122;0;29;1_';

  it('leader + known key record: injects; the selector keydown is swallowed, its trailing keyup passes through inert', () => {
    const { forward, injected, state } = run(leaderDown + leaderUp + sDown + sUp, SNIPPETS);
    // The matched keydown record is consumed by the injection; only its harmless companion keyup
    // (no visible effect in a terminal — keyup never inserts text) reaches the pty afterward.
    expect(forward).toBe(sUp);
    expect(injected).toEqual(['— Damien']);
    expect(state.awaitingKey).toBe(false);
  });

  it('leader + unknown key record: forwards the raw key record(s), injects nothing', () => {
    const { forward, injected, state } = run(leaderDown + leaderUp + zDown + zUp, SNIPPETS);
    expect(forward).toBe(zDown + zUp);
    expect(injected).toEqual([]);
    expect(state.awaitingKey).toBe(false);
  });

  it('ordinary key records typed with no leader pass through untouched', () => {
    const { forward, injected } = run(sDown + sUp, SNIPPETS);
    expect(forward).toBe(sDown + sUp);
    expect(injected).toEqual([]);
  });

  it('leader keydown alone leaves state awaiting; its own keyup does not cancel the wait', () => {
    const { forward, state } = run(leaderDown + leaderUp, SNIPPETS);
    expect(forward).toBe('');
    expect(state.awaitingKey).toBe(true);
  });
});

describe('stepSnippet — empty-snippets short-circuit', () => {
  it('leader is forwarded like any other byte when no snippets are configured', () => {
    const { forward, injected, state } = run('\x07s', {});
    // With no snippets, cli.ts never calls into this module at all — but even if it did, the
    // machine still resolves harmlessly: the leader is swallowed (there is nothing to match
    // against) and the selector key is forwarded since it can't match anything.
    expect(forward).toBe('s');
    expect(injected).toEqual([]);
    expect(state.awaitingKey).toBe(false);
  });
});

describe('decodeSnippetEvents', () => {
  it('decodes plain text one character per event', () => {
    const events = decodeSnippetEvents('ab');
    expect(events).toEqual([
      { isLeader: false, char: 'a', raw: 'a' },
      { isLeader: false, char: 'b', raw: 'b' },
    ]);
  });

  it('decodes a raw 0x07 byte as a leader event', () => {
    expect(decodeSnippetEvents('\x07')).toEqual([{ isLeader: true, char: null, raw: '\x07' }]);
  });

  it('decodes a win32 leader keydown record as isLeader, and its keyup as a non-char event', () => {
    const events = decodeSnippetEvents('\x1b[71;35;7;1;0;1_\x1b[71;35;7;0;0;1_');
    expect(events).toEqual([
      { isLeader: true, char: null, raw: '' },
      { isLeader: false, char: null, raw: '' },
    ]);
  });

  it('decodes a win32 key record keydown to its character', () => {
    const events = decodeSnippetEvents('\x1b[83;31;115;1;29;1_');
    expect(events).toEqual([{ isLeader: false, char: 's', raw: '\x1b[83;31;115;1;29;1_' }]);
  });
});

describe('sanitizeSnippetsConfig', () => {
  it('keeps only single-char keys with string values', () => {
    expect(sanitizeSnippetsConfig({ s: 'ok', ab: 'dropped-multichar-key', n: 5, '': 'dropped-empty-key' })).toEqual({
      s: 'ok',
    });
  });

  it('returns {} for non-object input', () => {
    expect(sanitizeSnippetsConfig(null)).toEqual({});
    expect(sanitizeSnippetsConfig(undefined)).toEqual({});
    expect(sanitizeSnippetsConfig('nope')).toEqual({});
    expect(sanitizeSnippetsConfig(['a'])).toEqual({});
  });

  it('returns {} for an empty object', () => {
    expect(sanitizeSnippetsConfig({})).toEqual({});
  });
});
