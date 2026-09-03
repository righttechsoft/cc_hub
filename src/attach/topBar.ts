// Pinned top status row for cc-attach: the pty runs one row short, every absolute row in the
// child's output stream is shifted down by one, a DECSTBM margin (2..rows) shields row 1 from
// scrolling, and the status text is painted into row 1 with DECSC/DECRC around it. Pure module.

// Per-cwd (or, when named, per-instance-name) status file in the OS temp dir — written by the
// user's statusline script, which duplicates this key derivation in plain JS (it can't import
// TS). Keep in sync. `name` (a named per-task agent identity — cc-attach --name / CC_HUB_NAME —
// already validated against core/identity.ts's INSTANCE_NAME_RE, so it's filename-safe as-is)
// takes a dedicated file so two same-folder wrappers with different names don't fight over one.
export function titleFileName(cwd: string, name?: string): string {
  if (name) return `cc-title-${name}.txt`;
  return `cc-title-${cwd.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.txt`;
}

// Status text lands inside our row-1 paint sequence: keep SGR color sequences, strip every other
// escape and control byte so the file content can never break out of row 1.
export function sanitizeStatus(raw: string): string {
  const oneLine = raw.split(/\r?\n/, 1)[0];
  let out = '';
  const re = /\x1b\[[0-9;]*m/g;
  let i = 0;
  for (const m of oneLine.matchAll(re)) {
    out += oneLine.slice(i, m.index).replace(/[\x00-\x1f\x7f]/g, '');
    out += m[0];
    i = m.index + m[0].length;
  }
  out += oneLine.slice(i).replace(/[\x00-\x1f\x7f]/g, '');
  return out;
}

export function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

// Inbound stdin sequences that carry a ROW coordinate arrive in OUTER-terminal coordinates
// (row 1 = the status bar); the child's screen starts at outer row 2, so shift them −1 before
// claude sees them. Covers CPR replies (ESC[row;colR, from conptyInheritCursor's cursor query)
// and SGR mouse events (ESC[<b;x;rowM / ...m — presses, releases, drags, wheel). Row 1 (a click
// on the bar itself) clamps to child row 1. ponytail: assumes sequences arrive unsplit in one
// stdin chunk, same as the existing Ctrl+V record matching.
export function shiftInputRows(s: string): string {
  return s
    .replace(/\x1b\[(\d+);(\d+)R/g, (_m, r: string, c: string) => `\x1b[${Math.max(1, Number(r) - 1)};${c}R`)
    .replace(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g, (_m, b: string, x: string, y: string, fin: string) => `\x1b[<${b};${x};${Math.max(1, Number(y) - 1)}${fin}`);
}

export interface TopBar {
  translate(chunk: string): string;
  setStatus(raw: string): string; // paint sequence, or '' if unchanged/empty
  resize(rows: number, cols: number): string; // re-setup sequence for new geometry
  initSeq(): string; // margins + paint, for startup
  resetSeq(): string; // margin reset for exit ('\x1b[r')
}

export function createTopBar(rows: number, cols: number): TopBar {
  let status = '';
  let carry = '';
  let lastCup = '';

  function paintSeq(): string {
    if (status === '') return '';
    let text = status;
    if (visibleLength(text) > cols - 1) {
      text = text.replace(/\x1b\[[0-9;]*m/g, '').slice(0, cols - 1);
    }
    return `\x1b7\x1b[1;1H\x1b[0m\x1b[2K${text}\x1b[0m\x1b8`;
  }

  function initSeq(): string {
    return `\x1b[2;${rows}r${paintSeq()}`;
  }

  const CUP_RE = /\x1b\[([0-9]*)(?:;([0-9]*))?([Hf])/g;
  const VPA_RE = /\x1b\[([0-9]*)d/g;
  const DECSTBM_RE = /\x1b\[([0-9]*)(?:;([0-9]*))?r/g;
  const PARTIAL_TAIL = /\x1b(?:\[[0-9;:?]{0,64}|\][^\x07\x1b]{0,512})?$/;

  return {
    setStatus(raw: string): string {
      const sanitized = sanitizeStatus(raw);
      if (sanitized === status || sanitized === '') return '';
      status = sanitized;
      return paintSeq();
    },

    resize(r: number, c: number): string {
      rows = r;
      cols = c;
      return initSeq() + lastCup;
    },

    initSeq,

    resetSeq(): string {
      return '\x1b[r';
    },

    translate(chunk: string): string {
      let s = carry + chunk;
      carry = '';

      const m = PARTIAL_TAIL.exec(s);
      if (m) {
        carry = m[0];
        s = s.slice(0, m.index);
      }

      const childRows = rows - 1;

      s = s.replace(CUP_RE, (_full, p1: string, p2: string) => {
        const row = (parseInt(p1, 10) || 1) + 1;
        const col = parseInt(p2, 10) || 1;
        lastCup = `\x1b[${row};${col}H`;
        return lastCup;
      });

      s = s.replace(VPA_RE, (_full, p1: string) => `\x1b[${(parseInt(p1, 10) || 1) + 1}d`);

      s = s.replace(DECSTBM_RE, (_full, p1: string, p2: string) => {
        const top = (parseInt(p1, 10) || 1) + 1;
        const bottom = (parseInt(p2, 10) || childRows) + 1;
        return `\x1b[${top};${bottom}r`;
      });

      if (s.includes('\x1b[?1049h') || s.includes('\x1b[?1049l') || s.includes('\x1bc')) {
        s += initSeq() + lastCup;
      } else if (s.includes('\x1b[2J') || s.includes('\x1b[1J')) {
        s += paintSeq();
      }

      return s;
    },
  };
}
