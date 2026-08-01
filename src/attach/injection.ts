// Pure formatting for injecting a remote prompt into a live Claude Code TUI. The wrapper writes
// the result directly into the pty; CC treats bracketed-paste content as a literal human paste,
// so embedded control bytes aren't interpreted as keybindings and the trailing \r submits it
// exactly like paste-then-Enter.
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

// Strips anything that could break out of paste mode or be misread as a control sequence:
// - embedded paste-end markers (breakout guard — without this, a message could smuggle its own
//   ESC[201~ and inject arbitrary keystrokes after "closing" the paste early)
// - C0 control chars other than \t/\n (keeps multi-line prompts intact)
// - DEL (0x7F)
// - lone \r, normalized away so the only carriage return is the final submit
export function sanitize(prompt: string): string {
  return prompt
    .split(PASTE_END)
    .join('')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/[\n\s]+$/g, '');
}

export function bracketedPaste(prompt: string): string {
  return PASTE_START + sanitize(prompt) + PASTE_END + '\r';
}
