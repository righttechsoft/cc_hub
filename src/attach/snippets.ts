// Pure logic for cc-attach's snippet / prompt-macro expansion: leader key (Ctrl+G) + one selector
// character expands to a config-defined canned text, injected into the live pty as a
// non-submitting bracketed paste so the human reviews it before pressing Enter. Kept side-effect
// free and pty-independent so it's unit-testable without a real pty — see cli.ts for the stateful
// wiring (module-scope state, the 3s auto-cancel timer, and the actual pty.write of an inject).
//
// Gated entirely on `snippets` being non-empty (checked in cli.ts before any of this runs): when
// there are no configured snippets, Ctrl+G is never intercepted at all.

// Mirrors cli.ts's WIN32_CTRL_V shape: conpty.dll turns on win32-input-mode (ESC[?9001h), so every
// keystroke — not just Ctrl+V — arrives encoded as `ESC[Vk;Sc;Uc;Kd;Cs;Rc_`. Uc is the key's
// unicode value, Kd is '1' on keydown / '0' on keyup. Ctrl+G's value is 7 (BEL), same as the raw
// byte sent by backends without win32-input-mode (in-box ConPTY, winpty).
const WIN32_KEY_RECORD_RE = /\x1b\[(\d+);(\d+);(\d+);([01]);(\d+);(\d+)_/g;
const LEADER_CHAR_CODE = 7; // Ctrl+G (BEL)

export interface SnippetEvent {
  // True exactly for the leader's own keydown (raw 0x07 byte, or a win32 record with Uc=7 and
  // Kd=1). The leader's keyup (win32 mode only) is reported as a plain non-char pass-through
  // event, never as a second leader event.
  isLeader: boolean;
  // Decoded character for a keydown event (raw ASCII byte, or a win32 record's Uc field). Null
  // for the leader itself and for any non-char/keyup event — those just pass through.
  char: string | null;
  // Exact bytes to forward if this event is not consumed (matched leader or matched selector both
  // forward nothing instead; everything else forwards `raw` verbatim, byte-for-byte).
  raw: string;
}

export interface SnippetState {
  // True after a leader keydown until the next char-bearing event resolves it (match, no-match,
  // or the cli.ts-owned 3s timeout resets state directly — this module has no notion of time).
  awaitingKey: boolean;
}

export interface SnippetStep {
  // Text to write to the pty for this event — '' when the event was fully consumed (leader, or a
  // matched selector).
  forward: string;
  // Present only when a selector matched a configured snippet — the raw snippet text to inject
  // (cli.ts wraps it in a non-submitting bracketedPaste()).
  inject?: string;
  state: SnippetState;
}

export const INITIAL_SNIPPET_STATE: SnippetState = { awaitingKey: false };

// Splits a decoded pty-input chunk into one event per keystroke, so the leader and the selector
// that follows it can be evaluated individually even when several keystrokes land in one stdin
// 'data' chunk. Plain (non-win32-record) bytes are decoded one at a time — cheap, and behaviorally
// identical to forwarding the whole run at once whenever the snippet machine isn't awaiting a
// selector (see stepSnippet's pass-through branches, which simply re-concatenate `raw`).
export function decodeSnippetEvents(chunk: string): SnippetEvent[] {
  const events: SnippetEvent[] = [];
  let lastIndex = 0;

  const pushPlainText = (text: string): void => {
    for (const ch of text) {
      if (ch.charCodeAt(0) === LEADER_CHAR_CODE) {
        events.push({ isLeader: true, char: null, raw: ch });
      } else {
        events.push({ isLeader: false, char: ch, raw: ch });
      }
    }
  };

  WIN32_KEY_RECORD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIN32_KEY_RECORD_RE.exec(chunk))) {
    if (match.index > lastIndex) pushPlainText(chunk.slice(lastIndex, match.index));
    const [full, , , ucStr, kdStr] = match;
    const uc = Number(ucStr);
    const isDown = kdStr === '1';
    if (uc === LEADER_CHAR_CODE) {
      // Leader's own keydown/keyup record: always fully swallowed (never forwarded), same
      // convention as the existing Ctrl+V handling — only the keydown fires the leader action.
      events.push({ isLeader: isDown, char: null, raw: '' });
    } else {
      // Any other key's record: a keydown decodes to its character; a keyup is an inert
      // pass-through so an ordinary keystroke — or the companion keyup of an unmatched
      // selector — still reaches claude byte-for-byte unchanged.
      events.push({ isLeader: false, char: isDown ? String.fromCharCode(uc) : null, raw: full });
    }
    lastIndex = WIN32_KEY_RECORD_RE.lastIndex;
  }
  if (lastIndex < chunk.length) pushPlainText(chunk.slice(lastIndex));

  return events;
}

// Consumes one already-decoded input event against the snippet map. See module doc for the
// leader/selector contract; behavior summary:
//   - not awaiting + leader        -> swallow, start awaiting.
//   - not awaiting + anything else -> forward unchanged, state untouched (snippet machine invisible).
//   - awaiting + leader            -> swallow, (re)start awaiting (re-pressing the leader resets it).
//   - awaiting + non-char event    -> forward unchanged (e.g. the leader's own keyup), keep awaiting.
//   - awaiting + known char        -> swallow, inject the snippet, stop awaiting.
//   - awaiting + unknown char      -> forward the key unchanged, stop awaiting.
export function stepSnippet(state: SnippetState, event: SnippetEvent, snippets: Record<string, string>): SnippetStep {
  if (event.isLeader) {
    return { forward: '', state: { awaitingKey: true } };
  }

  if (!state.awaitingKey) {
    return { forward: event.raw, state };
  }

  if (event.char === null) {
    return { forward: event.raw, state };
  }

  if (Object.prototype.hasOwnProperty.call(snippets, event.char)) {
    return { forward: '', inject: snippets[event.char], state: { awaitingKey: false } };
  }
  return { forward: event.raw, state: { awaitingKey: false } };
}

// Validates config.json's attach.snippets into a clean single-char -> text map: drops anything
// that isn't a plain object, keeps only entries whose key is exactly one character and whose
// value is a string. Never throws.
export function sanitizeSnippetsConfig(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return out;
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (key.length === 1 && typeof val === 'string') out[key] = val;
  }
  return out;
}
