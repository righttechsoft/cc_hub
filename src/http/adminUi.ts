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
import type { KbNoteRow, KbSearchResult, MessageRow } from '../types.js';

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

export function renderMessagesList(messages: MessageRow[]): string {
  if (messages.length === 0) return '<p class="empty-note">No messages.</p>';
  return messages
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
  body { background: var(--ink); color: var(--text); font-family: ui-sans-serif, system-ui, 'Segoe UI', sans-serif; }
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

  <section x-show="tab === 'messages'" x-cloak>
    <div class="flex items-center gap-3 mb-4">
      <button type="button" class="btn-a btn-quiet" hx-get="/api/v1/admin/messages-list" hx-target="#msg-list" hx-swap="innerHTML">Refresh</button>
      <p class="text-xs" style="color:var(--muted)">Deleting an unread broadcast stops it being delivered to remaining instances.</p>
    </div>
    <div class="max-w-3xl" id="msg-list" hx-get="/api/v1/admin/messages-list" hx-trigger="load, msg-changed from:body" hx-target="this" hx-swap="innerHTML">
      <p class="empty-note">Loading&hellip;</p>
    </div>
  </section>

</main>

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

</body>
</html>
`;
