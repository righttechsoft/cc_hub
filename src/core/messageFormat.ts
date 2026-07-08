import type { MessageRow } from '../types.js';

const KB_LINE = 'Shared knowledge base available: kb_search before solving setup/tooling problems from scratch.';

function formatHHMM(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function formatMessageLine(msg: MessageRow): string {
  const kind = msg.to_name ? 'direct' : 'broadcast';
  return `from ${msg.from_name} (${kind}, ${formatHHMM(msg.created_at)}): ${msg.body}`;
}

// SessionStart hook stdout: nudges the instance to check its inbox (if any) and to prefer the
// shared knowledge base over solving problems from scratch.
export function renderSessionStartBanner(unread: number): string {
  if (unread <= 0) {
    return `[cc-hub] ${KB_LINE}`;
  }
  return `[cc-hub] You have ${unread} unread message(s) from other Claude instances — call chat_inbox. ${KB_LINE}`;
}

// UserPromptSubmit hook stdout: renders unread messages as injected context.
export function renderInboxContext(msgs: MessageRow[]): string {
  if (msgs.length === 0) return '';
  return ['[cc-hub] Messages from other instances:', ...msgs.map(formatMessageLine)].join('\n');
}

// Stop hook decision reason: delivers a queued remote prompt as if the user had typed it.
export function renderStopBlockPrompt(prompt: string): string {
  return `A remote prompt was queued via cc-hub: ${prompt}\nExecute it now as if the user typed it.`;
}

// Chat delivery spawn prompt: injects unread messages into a headless turn for a session that
// was idle when they arrived (hooks only fire on activity, so nothing else would deliver them).
export function renderChatDeliveryPrompt(msgs: MessageRow[]): string {
  const lines = msgs.map(formatMessageLine).join('\n');
  return (
    '[cc-hub] Chat messages arrived from other Claude Code instances while this session was idle:\n' +
    lines +
    '\nRead them and act if needed. To reply, use the cc-hub MCP tools: call hub_register with your cwd first if not already registered in this session, then chat_send. If no reply or action is needed, acknowledge briefly and stop.'
  );
}

// Stop hook decision reason: blocks Stop on urgent unread messages instead of a queued prompt.
export function renderUrgentBlock(msgs: MessageRow[]): string {
  const urgent = msgs.filter((m) => m.urgent);
  if (urgent.length === 0) return '';
  return [
    '[cc-hub] Urgent messages from other instances:',
    ...urgent.map(formatMessageLine),
    'Handle these now, then continue what you were doing.',
  ].join('\n');
}
