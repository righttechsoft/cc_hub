// Paste hygiene for cc-attach's smart paste: transforms clipboard text BEFORE it's injected into
// the live pty. Because smart paste is always non-submitting (see cli.ts handleSmartPaste), the
// transformed result lands in the input box for the human to review before pressing Enter — so
// redaction/fencing here is visible, not silent. Pure and side-effect free; never throws.

interface SecretPattern {
  re: RegExp;
  kind: string;
}

// Order matters: more specific prefixes must run before broader ones that would also match them
// (sk-ant-... before the generic sk-...), since each replace() consumes the match so a later,
// broader pattern can no longer see it. PEM blocks run first and are replaced whole.
const SECRET_PATTERNS: SecretPattern[] = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, kind: 'private-key' },
  { re: /gh[pousr]_[A-Za-z0-9]{20,}/g, kind: 'github-token' },
  { re: /AKIA[0-9A-Z]{16}/g, kind: 'aws-key' },
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, kind: 'slack-token' },
  { re: /AIza[0-9A-Za-z_-]{35}/g, kind: 'google-key' },
  { re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, kind: 'jwt' },
  { re: /sk-ant-[A-Za-z0-9_-]{16,}/g, kind: 'anthropic-key' },
  { re: /sk-[A-Za-z0-9_-]{16,}/g, kind: 'api-key' },
];

function redactSecrets(text: string): string {
  let out = text;
  for (const { re, kind } of SECRET_PATTERNS) {
    out = out.replace(re, `«REDACTED:${kind}»`);
  }
  return out;
}

// Conservative "is this code" check: require at least one strong signal, so plain prose (which
// may well contain a stray semicolon or brace) is never fenced. Signal A: a line indented with
// 2+ spaces/tab immediately followed by a common code symbol. Signal B: one of the common code
// tokens/keywords appears on 2+ distinct lines (a single decorative token in prose isn't enough).
const INDENTED_SYMBOL_RE = /^[ \t]{2,}[{}()[\]<>.:+\-*/=]/m;
const CODE_TOKEN_RE = /;|\{|\}|=>|\bdef |\bfunction |\bclass |\bimport |\bconst |<\//;

function looksLikeCode(text: string): boolean {
  if (INDENTED_SYMBOL_RE.test(text)) return true;
  let matchingLines = 0;
  for (const line of text.split('\n')) {
    if (CODE_TOKEN_RE.test(line)) {
      matchingLines++;
      if (matchingLines >= 2) return true;
    }
  }
  return false;
}

function fenceIfCode(text: string): string {
  const newlineCount = (text.match(/\n/g) || []).length;
  if (newlineCount < 2) return text;
  if (text.trimStart().startsWith('```')) return text; // already fenced — don't double-wrap
  if (!looksLikeCode(text)) return text;
  return '```\n' + text + '\n```';
}

export function applyPasteHygiene(text: string, opts: { redact: boolean; fence: boolean }): string {
  try {
    let out = text;
    if (opts.redact) out = redactSecrets(out);
    if (opts.fence) out = fenceIfCode(out);
    return out;
  } catch {
    return text; // never throw — a hygiene bug must not block a paste
  }
}
