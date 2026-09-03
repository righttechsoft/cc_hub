// Admin page for cc_hub: view/edit/delete Athen KB notes and chat/broadcast messages from a
// browser. Two things live here:
//   1. ADMIN_HTML — the static page shell (served at GET /admin, see app.ts). LAN-only internal
//      tool, so it loads htmx + Alpine.js + Tailwind Play CDN + FlyonUI straight from CDN — no
//      build step, no bundling, no CSP to violate.
//   2. HTML-fragment renderers used by the /api/v1/admin/* routes in apiRoutes.ts, which are thin
//      wrappers over the same kb/messages repo + Athen service calls the JSON routes use. htmx
//      wants HTML back, not JSON, so these routes render fragments with the helpers below instead
//      of `c.json(...)`.
// Every dynamic value (note title/body/tags, message body, sender/recipient names) goes through
// esc() before landing in a template — these routes render arbitrary user-authored text, so a
// title of `<script>alert(1)</script>` must come back as inert text, not markup.
//
// Visual language ("Athenaeum" — the shared library the notes live in): ink-dark console, one
// warm brass accent, serif reserved for the wordmark + note titles (system Georgia — no webfont),
// monospace for ids/tags/timestamps. Signature detail: note rows read as book spines — a thin
// brass rule on the left edge that brightens on hover/selection. Tokens live in :root below;
// change the palette there, not inline.
import type { InstanceAppJoined, KbNoteRow, KbSearchResult, MessageRow } from '../types.js';
import type { OverlordAskTarget, OverlordCandidate, OverlordDispatchResult, OverlordFindResult } from '../overlord/overlord.js';
import type { DispatchCandidate, DispatchVia } from '../spawn/dispatcher.js';

const ESCAPE_MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch]);
}

function fmtTime(ms: number | null | undefined): string {
  return ms ? new Date(ms).toLocaleString() : '';
}

// --- Athen (KB) fragments ---

export function renderKbList(notes: KbNoteRow[]): string {
  if (notes.length === 0) return '<p class="empty-note">The shelf is empty — no notes yet.</p>';
  return notes
    .map(
      (n) => `<div class="spine" role="button" tabindex="0" title="${esc(n.title)}"
        hx-get="/api/v1/admin/kb-edit/${n.id}" hx-target="#kb-editor" hx-swap="innerHTML">
        <div class="spine-title">${esc(n.title)}</div>
        <div class="meta-line">#${n.id} &middot; ${esc(n.author_name)} &middot; ${esc(fmtTime(n.updated_at))}</div>
      </div>`
    )
    .join('');
}

export function renderKbSearchResults(results: KbSearchResult[]): string {
  if (results.length === 0) return '<p class="empty-note">No matches — try different words; search also works by meaning.</p>';
  return results
    .map(
      (r) => `<div class="spine" role="button" tabindex="0"
        hx-get="/api/v1/admin/kb-edit/${r.id}" hx-target="#kb-editor" hx-swap="innerHTML">
        <div class="spine-title">${esc(r.title)}</div>
        <div class="meta-line">${esc(r.tags || 'untagged')}</div>
        <div class="snippet">${esc(r.snippet)}</div>
      </div>`
    )
    .join('');
}

export interface KbFormState {
  id?: number;
  title: string;
  tags: string;
  body: string;
  authorName?: string;
  updatedAt?: number;
  isNew: boolean;
  error?: string;
}

export function renderKbForm(state: KbFormState): string {
  const action = state.isNew ? 'hx-post="/api/v1/admin/kb"' : `hx-put="/api/v1/admin/kb/${state.id}"`;
  const meta = state.isNew
    ? '<p class="meta-line mb-3">New note</p>'
    : `<p class="meta-line mb-3">#${state.id} &middot; by ${esc(state.authorName)} &middot; updated ${esc(fmtTime(state.updatedAt))}</p>`;
  const errorHtml = state.error ? `<div class="alert-danger mb-3">${esc(state.error)}</div>` : '';
  // Delete-confirm is Alpine-driven inline state (not htmx's native hx-confirm dialog): clicking
  // Delete flips confirmingDelete, swapping in a "Yes, delete / Cancel" pair; only "Yes, delete"
  // carries hx-delete, so the actual request only fires after that second, explicit click.
  const deleteBtn = state.isNew
    ? ''
    : `<div x-data="{ confirmingDelete: false }" class="mt-4 pt-3" style="border-top:1px solid var(--line)">
        <button type="button" x-show="!confirmingDelete" class="btn-a btn-danger-ghost"
          @click="confirmingDelete = true">Delete note</button>
        <div x-show="confirmingDelete" class="flex items-center gap-2">
          <span class="text-sm" style="color:var(--muted)">Delete note #${state.id}? This can&#39;t be undone.</span>
          <button type="button" class="btn-a btn-danger"
            hx-delete="/api/v1/admin/kb/${state.id}" hx-target="#kb-editor" hx-swap="innerHTML">Yes, delete</button>
          <button type="button" class="btn-a btn-quiet" @click="confirmingDelete = false">Cancel</button>
        </div>
      </div>`;

  return `<div>
    ${errorHtml}
    ${meta}
    <form ${action} hx-target="#kb-editor" hx-swap="innerHTML">
      <div class="mb-4">
        <label class="field-label" for="kb-f-title">Title</label>
        <input class="input-a serif text-base" id="kb-f-title" type="text" name="title" value="${esc(state.title)}" />
      </div>
      <div class="mb-4">
        <label class="field-label" for="kb-f-tags">Tags</label>
        <input class="input-a mono text-[13px]" id="kb-f-tags" type="text" name="tags" value="${esc(state.tags)}" placeholder="space separated" />
      </div>
      <div class="mb-4">
        <label class="field-label" for="kb-f-body">Body</label>
        <textarea class="input-a mono text-[13px] leading-relaxed" id="kb-f-body" name="body" rows="16">${esc(state.body)}</textarea>
      </div>
      <button type="submit" class="btn-a btn-brass">${state.isNew ? 'Create note' : 'Save changes'}</button>
    </form>
    ${deleteBtn}
  </div>`;
}

export function renderKbEditorEmpty(): string {
  return '<p class="empty-note">Select a note on the left, or click &quot;New note&quot;.</p>';
}

export function renderErrorFragment(message: string): string {
  return `<div class="alert-danger">${esc(message)}</div>`;
}

// --- Messages fragments ---

// opts.pageSize enables pagination: when the page came back full, a Load-more button is
// appended that fetches the next page (same kind, beforeId = oldest id shown) and REPLACES
// ITSELF with it — the standard htmx incremental-list pattern. Broadcast listings pass no
// opts (they list unpaged; rare + they're the cleanup target).
export function renderMessagesList(
  messages: MessageRow[],
  opts?: { kind?: 'direct'; pageSize?: number }
): string {
  if (messages.length === 0) return '<p class="empty-note">No messages.</p>';
  const cards = messages
    .map((m) => {
      const to = m.to_name ? `<span class="peer">${esc(m.to_name)}</span>` : '<span class="badge-brass">BROADCAST</span>';
      const urgent = m.urgent ? '<span class="badge-danger">URGENT</span>' : '';
      // Same Alpine-driven inline confirm pattern as the KB delete button (see renderKbForm):
      // Delete flips confirmingDelete; only the "Yes" button carries hx-delete.
      return `<div class="card-a p-4 mb-3" id="msg-${m.id}">
        <div class="flex justify-between items-start gap-3 mb-2">
          <span class="meta-line"><span class="peer">${esc(m.from_name)}</span> &rarr; ${to} ${urgent} <span class="opacity-60">&middot; ${esc(fmtTime(m.created_at))}</span></span>
          <div x-data="{ confirmingDelete: false }" class="flex items-center gap-1.5 shrink-0">
            <button type="button" x-show="!confirmingDelete" class="btn-a btn-danger-ghost btn-xs" @click="confirmingDelete = true">Delete</button>
            <span x-show="confirmingDelete" class="flex items-center gap-1.5">
              <span class="text-xs" style="color:var(--muted)">Sure?</span>
              <button type="button" class="btn-a btn-danger btn-xs"
                hx-delete="/api/v1/admin/messages/${m.id}" hx-target="#msg-${m.id}" hx-swap="outerHTML">Yes</button>
              <button type="button" class="btn-a btn-quiet btn-xs" @click="confirmingDelete = false">No</button>
            </span>
          </div>
        </div>
        <div class="whitespace-pre-wrap break-words text-sm leading-relaxed">${esc(m.body)}</div>
      </div>`;
    })
    .join('');

  const pageFull = opts?.pageSize !== undefined && messages.length === opts.pageSize;
  if (!pageFull) return cards;
  const oldestId = messages[messages.length - 1].id;
  const kindParam = opts?.kind ? `&kind=${opts.kind}` : '';
  const loadMore = `<button type="button" class="btn-a btn-quiet w-full"
    hx-get="/api/v1/admin/messages-list?beforeId=${oldestId}${kindParam}" hx-swap="outerHTML">
    Load older</button>`;
  return cards + loadMore;
}

// --- Sessions fragment ---

function relTime(ms: number | null | undefined): string {
  if (!ms) return '';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const SESSION_DOT_COLOR: Record<string, string> = {
  active: '#4CAF7D',
  idle: 'var(--muted)',
  interrupted: 'var(--danger)',
  continuing: 'var(--brass)',
};

export interface SessionListItem {
  id: string;
  instance_id: number;
  instance_name: string | null;
  cwd: string;
  status: string;
  last_event_at: number;
  last_prompt: string | null;
  attached: boolean;
  working: boolean;
  // What Claude Code's own `/name <x>` (or its auto-generated title) currently shows for this
  // session — see CLAUDE.md's "Session names" subsection. Additional context alongside the
  // instance name, not a replacement for it (a session's title can drift from the instance's
  // adopted identity, e.g. after `/name` is used again mid-conversation).
  session_name: string | null;
}

// One cc-attach wrapper per cwd means at most ONE session there can be "the" live terminal —
// the one with the newest activity. Older not-yet-ended rows in the same cwd (e.g. a session
// whose terminal was closed without a SessionEnd hook) must not inherit the cwd's attach flags.
export function newestSessionPerCwd(sessions: Pick<SessionListItem, 'id' | 'cwd' | 'last_event_at'>[]): Set<string> {
  const newest = new Map<string, { id: string; at: number }>();
  for (const s of sessions) {
    const cur = newest.get(s.cwd);
    if (!cur || (s.last_event_at ?? 0) > cur.at) newest.set(s.cwd, { id: s.id, at: s.last_event_at ?? 0 });
  }
  return new Set([...newest.values()].map((v) => v.id));
}

// Inline rename affordance (Alpine toggle, same pattern as the KB/message delete-confirm
// widgets): a quiet pencil button swaps in a name input + Save/Cancel, hx-post to the rename
// route, targeting the whole sessions list for refresh (see apiRoutes.ts's
// POST /admin/instances/rename). Renaming a running instance takes effect immediately for
// chat/attach routing; only a NAMED terminal's own CC_HUB_NAME env is unaffected until relaunch.
function renameWidget(s: SessionListItem): string {
  const displayName = esc(s.instance_name ?? s.id.slice(0, 8));
  return `<span x-data="{ renaming: false }" class="inline-flex items-center gap-1.5">
    <span x-show="!renaming" class="inline-flex items-center gap-1">
      <span class="font-semibold text-sm">${displayName}</span>
      <button type="button" class="btn-a btn-quiet btn-xs" title="Rename instance" @click="renaming = true">&#9998;</button>
    </span>
    <form x-show="renaming" hx-post="/api/v1/admin/instances/rename" hx-target="#sessions-list" hx-swap="innerHTML"
          class="inline-flex items-center gap-1">
      <input type="hidden" name="id" value="${s.instance_id}" />
      <input type="text" name="newName" value="${esc(s.instance_name ?? '')}" maxlength="40"
             class="input-a mono !text-xs !py-1 !px-1.5 !w-32" autocomplete="off" />
      <button type="submit" class="btn-a btn-brass btn-xs">Save</button>
      <button type="button" class="btn-a btn-quiet btn-xs" @click="renaming = false">Cancel</button>
    </form>
  </span>`;
}

const SESSION_NAME_DISPLAY_MAX_CHARS = 60;

function sessionCard(s: SessionListItem): string {
  const dot = SESSION_DOT_COLOR[s.status] ?? 'var(--muted)';
  const live = s.attached ? '<span class="badge-brass">LIVE</span>' : '';
  const working = s.working ? '<span class="badge-brass" title="claude is working">&#9889;</span>' : '';
  const prompt = s.last_prompt
    ? `<div class="snippet mt-1">${esc(s.last_prompt)}</div>`
    : '';
  const sessionName = s.session_name
    ? `<div class="meta-line">${esc(
        s.session_name.length > SESSION_NAME_DISPLAY_MAX_CHARS
          ? s.session_name.slice(0, SESSION_NAME_DISPLAY_MAX_CHARS - 1).trimEnd() + '…'
          : s.session_name
      )}</div>`
    : '';
  return `<div class="card-a p-3 mb-2">
    <div class="flex items-center gap-2 flex-wrap">
      <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${dot}"></span>
      ${renameWidget(s)}
      <span class="meta-line !mt-0">${esc(s.status)}</span>
      ${live} ${working}
      <span class="meta-line !mt-0 ml-auto">${esc(relTime(s.last_event_at))}</span>
    </div>
    <div class="meta-line">${esc(s.cwd)} &middot; ${esc(s.id.slice(0, 8))}</div>
    ${sessionName}
    ${prompt}
  </div>`;
}

// Attached-terminal sessions group first (latest activity on top) — those are the ones a human
// is actually sitting in. Non-attached sessions follow, also newest activity first. Group labels
// carry a shared `group-label` class (alongside their existing classes) so the client-side
// sessions filter script can find and hide them when their whole group is filtered out.
export function renderSessionsList(sessions: SessionListItem[]): string {
  if (sessions.length === 0) return '<p class="empty-note">No live sessions.</p>';

  const byActivity = (a: SessionListItem, b: SessionListItem) => (b.last_event_at ?? 0) - (a.last_event_at ?? 0);
  const open = sessions.filter((s) => s.attached).sort(byActivity);
  const rest = sessions.filter((s) => !s.attached).sort(byActivity);

  if (open.length > 0 && rest.length > 0) {
    return (
      '<p class="meta-line mb-1 group-label">Open terminals</p>' +
      open.map(sessionCard).join('') +
      '<p class="meta-line mt-3 mb-1 group-label">Other sessions</p>' +
      rest.map(sessionCard).join('')
    );
  }
  return open.map(sessionCard).join('') + rest.map(sessionCard).join('');
}

// --- AI Overlord fragment ---

function overlordCandidateCard(c: OverlordCandidate, index: number): string {
  const dot = SESSION_DOT_COLOR[c.status] ?? 'var(--muted)';
  const snippetsHtml = c.snippets
    .slice(0, 2)
    .map((s) => `<div class="snippet mt-1">${esc(s)}</div>`)
    .join('');
  const resumeCmd = `cd "${c.cwd}"; cc-attach --resume ${c.sessionId}`;
  return `<div class="card-a p-3 mb-2">
    <div class="flex items-center gap-2 flex-wrap">
      <span class="badge-brass">[${index}]</span>
      <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${dot}"></span>
      <span class="font-semibold text-sm">${esc(c.instance_name ?? c.sessionId.slice(0, 8))}</span>
      <span class="meta-line !mt-0">${esc(c.status)}</span>
      <span class="meta-line !mt-0 ml-auto">${esc(relTime(c.last_event_at))}</span>
    </div>
    <div class="meta-line">${esc(c.cwd || 'unknown')} &middot; ${esc(c.sessionId.slice(0, 8))}</div>
    <div class="flex items-center gap-2 mt-1">
      <code class="snippet !mt-0" style="user-select:all">${esc(resumeCmd)}</code>
      <button type="button" class="btn-a btn-quiet" onclick="copyText(this)" data-copy="${esc(resumeCmd)}">Copy</button>
    </div>
    ${snippetsHtml}
  </div>`;
}

// The AI cites sources inline as [n] (1-based, matching the numbered candidate list sent in the
// prompt). Ordered, deduped, out-of-range indexes dropped.
function parseCitedIndexes(answer: string, candidateCount: number): number[] {
  const seen = new Set<number>();
  const ordered: number[] = [];
  for (const m of answer.matchAll(/\[(\d+)\]/g)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= candidateCount && !seen.has(n)) {
      seen.add(n);
      ordered.push(n);
    }
  }
  return ordered;
}

// Answer text esc'd (never trusted as markup) then reflowed into paragraphs on blank lines, single
// newlines within a paragraph become <br>. Candidate sessions render below, numbered [1], [2]... to
// match the answer's own [n] references, reusing the sessions tab's card visual language.
// Candidates render in recency order but the AI's citations are what actually matters — a
// deterministic reorder puts cited matches on top (in citation order) while every card keeps its
// original [n] label, so the answer text stays coherent; leftover uncited candidates collapse into
// a <details> disclosure instead of burying the real match under recency noise.
export function renderOverlordAnswer(result: OverlordFindResult): string {
  const paragraphs = esc(result.answer)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => `<p class="mb-2 leading-relaxed">${p.replace(/\n/g, '<br>')}</p>`)
    .join('');
  const answerHtml = `<div class="card-a p-4 mb-4">${paragraphs || '<p class="empty-note">No answer.</p>'}</div>`;

  if (result.candidates.length === 0) return answerHtml;

  const cited = parseCitedIndexes(result.answer, result.candidates.length);
  if (cited.length === 0) {
    return answerHtml + result.candidates.map((c, i) => overlordCandidateCard(c, i + 1)).join('');
  }

  const citedSet = new Set(cited);
  const citedHtml = cited.map((n) => overlordCandidateCard(result.candidates[n - 1], n)).join('');
  const uncited = result.candidates.map((_, i) => i + 1).filter((n) => !citedSet.has(n));
  const uncitedHtml =
    uncited.length === 0
      ? ''
      : `<details class="mt-3"><summary class="meta-line" style="cursor:pointer">Other candidates (${uncited.length})</summary>${uncited
          .map((n) => overlordCandidateCard(result.candidates[n - 1], n))
          .join('')}</details>`;

  return answerHtml + citedHtml + uncitedHtml;
}

// --- AI Overlord: ask mode (confirm -> send -> replies) ---

// Ask mode never sends on the first ask — this renders the confirmation step: the (esc'd) message
// that would be sent, the resolved target list, and a form that only fires POST overlord-send when
// the human clicks Send. One hidden <input name="targets"> per target lets apiRoutes.ts read them
// back as an array via parseBody({ all: true }). Cancel just clears the answer div in place — no
// route needed, nothing was sent yet.
// Non-live scope matches skipped by default (see resolveAskTargets/partitionAskTargets in
// overlord.ts) — a muted hint line, never blocking: it tells the human how to widen the net
// ("including inactive") rather than silently dropping matches from view.
function renderOverlordExcluded(excluded: OverlordAskTarget[]): string {
  if (excluded.length === 0) return '';
  const names = excluded.map((t) => esc(t.name)).join(', ');
  return `<p class="meta-line mb-2">Skipped ${excluded.length} inactive instance(s): ${names} &mdash; say "including inactive" to reach them (each gets a fresh headless session).</p>`;
}

export function renderOverlordConfirm(
  message: string,
  targets: OverlordAskTarget[],
  excluded: OverlordAskTarget[] = []
): string {
  if (targets.length === 0) {
    if (excluded.length === 0) {
      return renderErrorFragment('No known instances match that scope — nothing to send to.');
    }
    // Every scope match exists but none is currently live — no Send button; there is nothing to
    // send to without explicitly opting into a headless spawn via "including inactive".
    return `<div class="card-a p-4 mb-3">
      <p class="meta-line !mt-0 mb-2">No matching instance is currently active — nothing was sent.</p>
      ${renderOverlordExcluded(excluded)}
    </div>`;
  }

  const targetRows = targets
    .map(
      (t) =>
        `<li class="flex items-baseline gap-2"><span class="peer">${esc(t.name)}</span><span class="meta-line !mt-0">${esc(t.cwd)}</span></li>`
    )
    .join('');
  const hiddenTargets = targets.map((t) => `<input type="hidden" name="targets" value="${esc(t.name)}" />`).join('');

  return `<div class="card-a p-4 mb-3">
    <p class="meta-line mb-2">Overlord will send this message directly to ${targets.length} instance(s):</p>
    <div class="snippet !mt-0 mb-3" style="white-space:pre-wrap; -webkit-line-clamp:unset">${esc(message)}</div>
    <ul class="mb-3 flex flex-col gap-1">${targetRows}</ul>
    ${renderOverlordExcluded(excluded)}
    <form hx-post="/api/v1/admin/overlord-send" hx-target="#overlord-answer" hx-swap="innerHTML" class="flex items-center gap-2">
      <input type="hidden" name="message" value="${esc(message)}" />
      ${hiddenTargets}
      <button type="submit" class="btn-a btn-brass">Send</button>
      <button type="button" class="btn-a btn-quiet"
        onclick="document.getElementById('overlord-answer').innerHTML = ''">Cancel</button>
    </form>
  </div>`;
}

// After Send: confirms who got the message, then a self-polling div that fetches
// GET overlord-replies?afterId=<sinceId> (the message-id watermark captured right before the sends)
// every 3s. The route response replaces this div's *contents* only (hx-target="this"), same pattern
// as the sessions-list poll — the hx-get/hx-trigger stay on this element across polls.
export function renderOverlordSent(targets: string[], sinceId: number): string {
  return `<div class="card-a p-3 mb-3">
    <p class="meta-line !mt-0">Sent to ${targets.length} instance(s): ${targets.map((t) => esc(t)).join(', ')}</p>
  </div>
  <div id="overlord-replies" hx-get="/api/v1/admin/overlord-replies?afterId=${sinceId}"
       hx-trigger="load, every 3s" hx-target="this" hx-swap="innerHTML">
    <p class="empty-note">Waiting for replies&hellip;</p>
  </div>`;
}

// Rendered inside the polling div above — just the cards (or the empty-state note), never the
// wrapping div itself. Replies are messages addressed to the reserved 'overlord' recipient.
export function renderOverlordReplies(replies: MessageRow[]): string {
  if (replies.length === 0) return '<p class="empty-note">No replies yet&hellip;</p>';
  return replies
    .map(
      (m) => `<div class="card-a p-3 mb-2">
        <div class="meta-line !mt-0"><span class="peer">${esc(m.from_name)}</span> &middot; ${esc(relTime(m.created_at))}</div>
        <div class="whitespace-pre-wrap break-words text-sm leading-relaxed mt-1">${esc(m.body)}</div>
      </div>`
    )
    .join('');
}

// --- AI Overlord: dispatch mode (confirm -> dispatch) ---

function overlordDispatchCandidateRow(c: DispatchCandidate): string {
  const state = c.working ? 'working' : c.attached ? 'idle, attached' : 'not attached';
  return `<li class="flex items-baseline gap-2"><span class="peer">${esc(c.name)}</span><span class="meta-line !mt-0">${esc(c.cwd)}</span><span class="meta-line !mt-0">${esc(state)}</span></li>`;
}

// Dispatch mode never acts on the first ask — this renders the confirmation step: the plan in
// plain words (reuse vs. open a new tab), the task text, the resolved candidate list (with
// live/working state), and a form that only fires POST overlord-dispatch when the human clicks
// Dispatch. Hidden inputs round-trip the plan's action/name/cwd/task so the dispatch route can
// re-validate it fresh rather than trusting stale client state. Cancel just clears the answer div
// in place — no route needed, nothing was executed yet.
export function renderOverlordDispatchConfirm(result: OverlordDispatchResult): string {
  const { action, task, candidates } = result;
  const planLine =
    action.kind === 'inject'
      ? `Reuse the idle terminal <span class="peer">${esc(action.name)}</span> in ${esc(action.cwd)}`
      : `Open a NEW terminal tab in ${esc(action.cwd)} as <span class="peer">${esc(action.name)}</span>`;
  const candidateRows =
    candidates.length > 0
      ? `<ul class="mb-3 flex flex-col gap-1">${candidates.map(overlordDispatchCandidateRow).join('')}</ul>`
      : '';

  return `<div class="card-a p-4 mb-3">
    <p class="meta-line mb-2">${planLine}</p>
    <div class="snippet !mt-0 mb-3" style="white-space:pre-wrap; -webkit-line-clamp:unset">${esc(task)}</div>
    ${candidateRows}
    <form hx-post="/api/v1/admin/overlord-dispatch" hx-target="#overlord-answer" hx-swap="innerHTML" class="flex items-center gap-2">
      <input type="hidden" name="action" value="${esc(action.kind)}" />
      <input type="hidden" name="name" value="${esc(action.name)}" />
      <input type="hidden" name="cwd" value="${esc(action.cwd)}" />
      <input type="hidden" name="task" value="${esc(task)}" />
      <button type="submit" class="btn-a btn-brass">Dispatch</button>
      <button type="button" class="btn-a btn-quiet"
        onclick="document.getElementById('overlord-answer').innerHTML = ''">Cancel</button>
    </form>
  </div>`;
}

// After Dispatch: one outcome line per `via`. 'spawned_no_inject' also surfaces the task in a
// copyable snippet (reusing the copyText() button pattern from the Overlord candidate cards)
// since a human now needs to paste it into the freshly opened tab themselves.
export function renderOverlordDispatched(via: DispatchVia, name: string, cwd: string, task: string): string {
  if (via === 'failed') {
    return renderErrorFragment(`Failed to dispatch to ${name} — see hub logs.`);
  }
  if (via === 'injected') {
    return `<div class="card-a p-3 mb-3"><p class="meta-line !mt-0">Task sent to <span class="peer">${esc(name)}</span>.</p></div>`;
  }
  if (via === 'spawned') {
    return `<div class="card-a p-3 mb-3"><p class="meta-line !mt-0">Opened a new tab as <span class="peer">${esc(name)}</span> and sent the task.</p></div>`;
  }
  // spawned_no_inject
  return `<div class="card-a p-3 mb-3">
    <p class="meta-line !mt-0 mb-2">Opened a new tab as <span class="peer">${esc(name)}</span> in ${esc(cwd)} &mdash; it didn&#39;t register in time. Paste the task manually:</p>
    <div class="flex items-center gap-2">
      <code class="snippet !mt-0" style="user-select:all">${esc(task)}</code>
      <button type="button" class="btn-a btn-quiet" onclick="copyText(this)" data-copy="${esc(task)}">Copy</button>
    </div>
  </div>`;
}

// --- Instance running-apps footer ---

const HTTP_URL_RE = /^https?:\/\//i;

// Rows come from instanceAppsRepo.listAllJoined (most recently updated app first, across all
// instances). Groups them per instance, preserving that ordering — an instance's group appears
// where its most-recently-updated app falls, and apps within a group keep the same relative
// order. Renders the footer bar's *contents* only (a flex-wrap parent lives in the page shell
// below) — an empty list collapses to '', so the footer bar reads as empty rather than stale markup.
export function renderInstanceApps(rows: InstanceAppJoined[]): string {
  if (rows.length === 0) return '';

  const order: string[] = [];
  const groups = new Map<string, InstanceAppJoined[]>();
  for (const row of rows) {
    let group = groups.get(row.instance_name);
    if (!group) {
      group = [];
      groups.set(row.instance_name, group);
      order.push(row.instance_name);
    }
    group.push(row);
  }

  return order
    .map((name) => {
      const nameHtml = `<span class="mono" style="color:var(--muted)">${esc(name)}</span>`;
      const appsHtml = groups
        .get(name)!
        .map((app) => {
          // Defense in depth against a hand-inserted DB row: only emit an anchor for a value that
          // still passes the http(s) check at render time, else show it as an inert label — same
          // treatment a desktop app (url === null) gets.
          if (app.url && HTTP_URL_RE.test(app.url)) {
            return `<a class="link-brass" href="${esc(app.url)}" target="_blank" rel="noopener noreferrer" title="${esc(app.url)}">${esc(app.label)}</a>`;
          }
          return `<span style="color:var(--muted)">${esc(app.label)}</span>`;
        })
        .join(' ');
      return `<span class="flex items-center gap-1.5">${nameHtml} ${appsHtml}</span>`;
    })
    .join('');
}

// --- Page shell ---
// CDN versions pinned as of writing (all fetched and confirmed live): htmx.org 2.0.10,
// alpinejs 3.15.12, flyonui 2.4.1 (ships flat as flyonui.css/flyonui.js, no dist/ subpath),
// Tailwind Play CDN 3.4.17. Bump these in one place if a future FlyonUI/Tailwind major changes
// class names — nothing else in this file needs to change. Versions are pinned in the URLs but
// deliberately carry NO SRI integrity hashes: hand-computed hashes proved wrong for two of the
// five assets (browser refused to execute htmx + Tailwind, silently killing the whole page), and
// cdn.tailwindcss.com serves a dynamic script SRI can never be stable against. Pinned versions on
// jsdelivr are protection enough for a LAN-only internal tool.
export const ADMIN_HTML = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>cc_hub &middot; Athenaeum admin</title>
<script src="https://cdn.tailwindcss.com/3.4.17"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/flyonui@2.4.1/flyonui.css" />
<script src="https://cdn.jsdelivr.net/npm/htmx.org@2.0.10/dist/htmx.min.js" defer></script>
<script src="https://cdn.jsdelivr.net/npm/alpinejs@3.15.12/dist/cdn.min.js" defer></script>
<script src="https://cdn.jsdelivr.net/npm/flyonui@2.4.1/flyonui.js" defer></script>
<style>
  :root {
    --ink: #0E1116;        /* page ground */
    --panel: #151A21;      /* cards, list */
    --panel2: #1B222C;     /* hover / raised */
    --line: #28303C;       /* hairlines */
    --text: #DCE3EC;
    --muted: #8A96A3;
    --brass: #C9A961;      /* the one accent — library brass */
    --brass-dim: rgba(201, 169, 97, 0.32);
    --danger: #D9605A;
  }
  [x-cloak] { display: none !important; }
  html { background: var(--ink); }
  body { background: var(--ink); color: var(--text); font-family: ui-sans-serif, system-ui, 'Segoe UI', sans-serif;
    padding-bottom: 3.25rem; /* clears the sticky instance-urls footer */ }
  .serif { font-family: Georgia, Cambria, 'Times New Roman', serif; }
  .mono { font-family: ui-monospace, Consolas, 'Cascadia Mono', monospace; }

  .card-a { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; }

  .input-a { display: block; width: 100%; background: var(--ink); border: 1px solid var(--line);
    border-radius: 8px; color: var(--text); padding: 0.5rem 0.75rem; font-size: 0.875rem; }
  .input-a::placeholder { color: var(--muted); opacity: 0.7; }
  .input-a:focus { outline: 2px solid var(--brass); outline-offset: -1px; }

  .btn-a { display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem;
    border-radius: 8px; padding: 0.45rem 0.9rem; font-size: 0.8rem; font-weight: 600;
    cursor: pointer; border: 1px solid transparent; transition: filter 0.15s, background 0.15s; }
  .btn-a:focus-visible { outline: 2px solid var(--brass); outline-offset: 2px; }
  .btn-a.btn-xs { padding: 0.2rem 0.55rem; font-size: 0.7rem; }
  .btn-brass { background: var(--brass); color: #171207; }
  .btn-brass:hover { filter: brightness(1.1); }
  .btn-quiet { border-color: var(--line); color: var(--text); background: transparent; }
  .btn-quiet:hover { background: var(--panel2); }
  .btn-danger { background: var(--danger); color: #fff; }
  .btn-danger:hover { filter: brightness(1.08); }
  .btn-danger-ghost { border-color: var(--danger); color: var(--danger); background: transparent; }
  .btn-danger-ghost:hover { background: rgba(217, 96, 90, 0.12); }

  /* Signature: note rows as book spines — brass rule warms on hover/keyboard focus. */
  .spine { border-left: 3px solid var(--brass-dim); background: transparent; padding: 0.6rem 0.75rem;
    margin-bottom: 0.375rem; border-radius: 0 8px 8px 0; cursor: pointer;
    transition: background 0.15s, border-color 0.15s; }
  .spine:hover, .spine:focus-visible { border-left-color: var(--brass); background: var(--panel2); outline: none; }
  .spine-title { font-family: Georgia, Cambria, 'Times New Roman', serif; font-size: 0.95rem; line-height: 1.35;
    overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .snippet { font-size: 0.75rem; color: var(--muted); margin-top: 0.25rem; overflow: hidden;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }

  .meta-line { font-family: ui-monospace, Consolas, 'Cascadia Mono', monospace; font-size: 0.7rem;
    color: var(--muted); margin-top: 0.2rem; }
  .field-label { display: block; font-family: ui-monospace, Consolas, monospace; font-size: 0.68rem;
    letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); margin-bottom: 0.35rem; }
  .empty-note { font-size: 0.8rem; color: var(--muted); padding: 0.5rem 0.25rem; }

  .badge-brass, .badge-danger { font-family: ui-monospace, Consolas, monospace; font-size: 0.62rem;
    letter-spacing: 0.08em; padding: 0.1rem 0.4rem; border-radius: 5px; vertical-align: 1px; }
  .badge-brass { border: 1px solid var(--brass); color: var(--brass); }
  .badge-danger { border: 1px solid var(--danger); color: var(--danger); }
  .peer { color: var(--text); }

  .alert-danger { background: rgba(217, 96, 90, 0.1); border: 1px solid var(--danger);
    color: var(--text); border-radius: 8px; padding: 0.6rem 0.9rem; font-size: 0.85rem; }

  .tab-a { padding: 0 0 0.55rem 0; margin-bottom: -1px; font-size: 0.85rem; font-weight: 600;
    color: var(--muted); border-bottom: 2px solid transparent; transition: color 0.15s; }
  .tab-a:hover { color: var(--text); }
  .tab-a.tab-on { color: var(--text); border-bottom-color: var(--brass); }

  .link-brass { color: var(--brass); text-decoration: none; }
  .link-brass:hover { text-decoration: underline; }
</style>
</head>
<body class="min-h-screen" x-data="{ tab: 'athen' }">

<header style="background:var(--panel); border-bottom:1px solid var(--line)">
  <div class="max-w-6xl mx-auto px-6 py-3 flex items-end gap-4 flex-wrap">
    <div class="flex-1 min-w-[200px]">
      <div class="mono text-[10px] uppercase tracking-[0.22em]" style="color:var(--muted)">cc_hub admin</div>
      <div class="serif text-2xl leading-tight" style="color:var(--brass)">Athenaeum</div>
    </div>
    <div class="flex items-center gap-2 pb-0.5" x-data="{ token: localStorage.getItem('ccHubToken') || '' }">
      <input type="password" x-model="token" placeholder="Bearer token" autocomplete="off"
        class="input-a mono !w-56 !text-xs" />
      <button type="button" class="btn-a btn-quiet"
        @click="localStorage.setItem('ccHubToken', token.trim()); location.reload()">
        Save token
      </button>
    </div>
  </div>
</header>

<div id="bad-token-alert" class="hidden max-w-6xl mx-auto px-6 mt-4">
  <div class="alert-danger">Bad token &mdash; paste the authToken from config.json above and click Save token.</div>
</div>

<nav class="max-w-6xl mx-auto px-6 mt-6 flex gap-7" style="border-bottom:1px solid var(--line)">
  <button type="button" class="tab-a" :class="tab === 'athen' ? 'tab-on' : ''" @click="tab = 'athen'">Athen</button>
  <button type="button" class="tab-a" :class="tab === 'messages' ? 'tab-on' : ''" @click="tab = 'messages'">Messages</button>
  <button type="button" class="tab-a" :class="tab === 'sessions' ? 'tab-on' : ''" @click="tab = 'sessions'">Sessions</button>
  <button type="button" class="tab-a" :class="tab === 'overlord' ? 'tab-on' : ''" @click="tab = 'overlord'">AI Overlord</button>
</nav>

<main class="max-w-6xl mx-auto px-6 py-6">

  <section x-show="tab === 'athen'">
    <div class="flex flex-wrap gap-2 mb-4">
      <input type="search" name="q" placeholder="Search the library by meaning or keyword&hellip;"
        class="input-a flex-1 min-w-[220px] !w-auto"
        hx-get="/api/v1/admin/kb-search" hx-trigger="keyup changed delay:400ms, search" hx-target="#kb-list" hx-swap="innerHTML" />
      <button type="button" class="btn-a btn-quiet" hx-get="/api/v1/admin/kb-list" hx-target="#kb-list" hx-swap="innerHTML">Recent</button>
      <button type="button" class="btn-a btn-brass" hx-get="/api/v1/admin/kb-new" hx-target="#kb-editor" hx-swap="innerHTML">New note</button>
    </div>
    <div class="grid grid-cols-1 md:grid-cols-[340px_1fr] gap-5 items-start">
      <div class="card-a p-2.5 max-h-[72vh] overflow-y-auto"
           id="kb-list" hx-get="/api/v1/admin/kb-list" hx-trigger="load, kb-changed from:body" hx-target="this" hx-swap="innerHTML">
        <p class="empty-note">Opening the catalogue&hellip;</p>
      </div>
      <div class="card-a p-5" id="kb-editor">
        <p class="empty-note">Select a note on the left, or click "New note".</p>
      </div>
    </div>
  </section>

  <section x-show="tab === 'messages'" x-cloak x-data="{ kind: 'all' }">
    <div class="flex items-center gap-3 mb-4 flex-wrap">
      <div class="flex gap-1.5">
        <button type="button" class="btn-a" :class="kind === 'all' ? 'btn-brass' : 'btn-quiet'" @click="kind = 'all'"
          hx-get="/api/v1/admin/messages-list" hx-target="#msg-list" hx-swap="innerHTML">All</button>
        <button type="button" class="btn-a" :class="kind === 'broadcast' ? 'btn-brass' : 'btn-quiet'" @click="kind = 'broadcast'"
          hx-get="/api/v1/admin/messages-list?kind=broadcast" hx-target="#msg-list" hx-swap="innerHTML">Broadcast</button>
        <button type="button" class="btn-a" :class="kind === 'direct' ? 'btn-brass' : 'btn-quiet'" @click="kind = 'direct'"
          hx-get="/api/v1/admin/messages-list?kind=direct" hx-target="#msg-list" hx-swap="innerHTML">Direct</button>
      </div>
      <p class="text-xs" style="color:var(--muted)">Deleting an unread broadcast stops it being delivered to remaining instances.</p>
    </div>
    <div class="max-w-3xl" id="msg-list" hx-get="/api/v1/admin/messages-list" hx-trigger="load, msg-changed from:body" hx-target="this" hx-swap="innerHTML">
      <p class="empty-note">Loading&hellip;</p>
    </div>
  </section>

  <section x-show="tab === 'sessions'" x-cloak>
    <p class="text-xs mb-4" style="color:var(--muted)">Live Claude Code sessions across all instances. LIVE = open in a cc-attach terminal; &#9889; = claude is working right now. Refreshes every 5s.</p>
    <input type="text" id="sessions-filter" placeholder="Filter sessions&hellip;" class="input-a max-w-xs mb-3"
      oninput="applySessionsFilter()" autocomplete="off">
    <div class="max-w-3xl" id="sessions-list" hx-get="/api/v1/admin/sessions-list" hx-trigger="load, every 5s" hx-target="this" hx-swap="innerHTML">
      <p class="empty-note">Loading&hellip;</p>
    </div>
  </section>

  <section x-show="tab === 'overlord'" x-cloak>
    <p class="text-xs mb-4" style="color:var(--muted)">Ask a natural-language question over past Claude Code sessions &mdash; e.g. &quot;find a session where I fixed the date bug&quot; &mdash; ask/tell the agents something (e.g. &quot;ask all wonkybox sessions what&#39;s blocking them&quot;) &mdash; or dispatch a task to a project (e.g. &quot;implement the CSV export in wonkybox2_api&quot;), reusing an idle terminal or opening a new one &mdash; you&#39;ll confirm before anything is sent, spawned, or injected.</p>
    <form class="flex gap-2 mb-4 max-w-3xl items-center"
          hx-post="/api/v1/admin/overlord-ask" hx-target="#overlord-answer" hx-swap="innerHTML" hx-indicator="#overlord-indicator">
      <input type="text" id="overlord-q" name="q" maxlength="500" placeholder="Find a session where I&hellip;"
        class="input-a flex-1" autocomplete="off" />
      <button type="submit" class="btn-a btn-brass">Ask</button>
      <span id="overlord-indicator" class="htmx-indicator meta-line !mt-0">Thinking&hellip;</span>
    </form>
    <div class="max-w-3xl" id="overlord-answer"></div>
  </section>

</main>

<footer style="position:sticky; bottom:0; background:var(--panel); border-top:1px solid var(--line)">
  <div class="max-w-6xl mx-auto px-6 py-2 flex flex-wrap gap-x-5 gap-y-1 items-center text-xs"
       id="instance-urls" hx-get="/api/v1/admin/instance-urls" hx-trigger="load, every 15s" hx-swap="innerHTML">
  </div>
</footer>

<script>
  document.body.addEventListener('htmx:configRequest', function (evt) {
    evt.detail.headers['Authorization'] = 'Bearer ' + (localStorage.getItem('ccHubToken') || '');
  });
  document.body.addEventListener('htmx:responseError', function (evt) {
    if (evt.detail.xhr.status === 401) {
      document.getElementById('bad-token-alert').classList.remove('hidden');
    }
  });
  document.body.addEventListener('htmx:beforeSwap', function (evt) {
    var status = evt.detail.xhr.status;
    // Swap client-error bodies too (404/400/etc.) so the target shows the server's error
    // fragment instead of doing nothing; 401 is handled separately above via the alert banner.
    if (status >= 400 && status < 500 && status !== 401) {
      evt.detail.shouldSwap = true;
      evt.detail.isError = false;
    }
  });
</script>

<script>
  // Live client-side sessions filter: matches any text on a card, instantly, and re-applies
  // after every htmx poll swap. A group label hides when none of its cards survive the filter.
  function applySessionsFilter() {
    var q = (document.getElementById('sessions-filter')?.value || '').trim().toLowerCase();
    var list = document.getElementById('sessions-list');
    if (!list) return;
    var children = Array.from(list.children);
    // First pass: cards.
    for (var el of children) {
      if (!el.classList.contains('card-a')) continue;
      el.style.display = !q || el.textContent.toLowerCase().includes(q) ? '' : 'none';
    }
    // Second pass: labels — visible iff at least one card before the next label is visible.
    for (var i = 0; i < children.length; i++) {
      if (!children[i].classList.contains('group-label')) continue;
      var anyVisible = false;
      for (var j = i + 1; j < children.length && !children[j].classList.contains('group-label'); j++) {
        if (children[j].classList.contains('card-a') && children[j].style.display !== 'none') { anyVisible = true; break; }
      }
      children[i].style.display = anyVisible ? '' : 'none';
    }
  }
  document.body.addEventListener('htmx:afterSwap', function (e) {
    if (e.target && e.target.id === 'sessions-list') applySessionsFilter();
  });
</script>

<script>
  // Copy-to-clipboard for resume commands (Overlord candidate cards). navigator.clipboard needs a
  // secure context; the admin page is often opened over plain http via LAN IP, hence the fallback.
  function copyText(btn) {
    var t = btn.getAttribute('data-copy');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1500); }).catch(function () { fallbackCopy(t, btn); });
    } else { fallbackCopy(t, btn); }
  }
  function fallbackCopy(t, btn) {
    var ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1500); } catch (e) {}
    document.body.removeChild(ta);
  }
</script>

</body>
</html>
`;
