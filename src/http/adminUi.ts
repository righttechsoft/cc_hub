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
  if (notes.length === 0) return '<p class="text-base-content/60 text-sm p-2">No notes.</p>';
  return notes
    .map(
      (n) => `<div class="card bg-base-200 hover:bg-base-300 cursor-pointer p-3 mb-2 transition-colors"
        hx-get="/api/v1/admin/kb-edit/${n.id}" hx-target="#kb-editor" hx-swap="innerHTML">
        <div class="font-semibold text-sm">${esc(n.title)}</div>
        <div class="text-xs text-base-content/60 mt-1">#${n.id} &middot; ${esc(n.author_name)} &middot; ${esc(fmtTime(n.updated_at))}</div>
      </div>`
    )
    .join('');
}

export function renderKbSearchResults(results: KbSearchResult[]): string {
  if (results.length === 0) return '<p class="text-base-content/60 text-sm p-2">No matches.</p>';
  return results
    .map(
      (r) => `<div class="card bg-base-200 hover:bg-base-300 cursor-pointer p-3 mb-2 transition-colors"
        hx-get="/api/v1/admin/kb-edit/${r.id}" hx-target="#kb-editor" hx-swap="innerHTML">
        <div class="font-semibold text-sm">${esc(r.title)}</div>
        <div class="text-xs text-base-content/60 mt-1">tags: ${esc(r.tags || '-')}</div>
        <div class="text-xs text-base-content/60">${esc(r.snippet)}</div>
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
    ? '<p class="text-xs text-base-content/60 mb-2">New note</p>'
    : `<p class="text-xs text-base-content/60 mb-2">#${state.id} &middot; by ${esc(state.authorName)} &middot; updated ${esc(fmtTime(state.updatedAt))}</p>`;
  const errorHtml = state.error ? `<div class="alert alert-error text-sm mb-2"><span>${esc(state.error)}</span></div>` : '';
  const deleteBtn = state.isNew
    ? ''
    : `<button type="button" class="btn btn-error btn-outline btn-sm mt-2"
        hx-delete="/api/v1/admin/kb/${state.id}" hx-target="#kb-editor" hx-swap="innerHTML"
        hx-confirm="Delete note #${state.id}?">Delete</button>`;

  return `<div>
    ${errorHtml}
    ${meta}
    <form ${action} hx-target="#kb-editor" hx-swap="innerHTML">
      <div class="mb-3">
        <label class="label"><span class="label-text">Title</span></label>
        <input class="input input-bordered w-full" type="text" name="title" value="${esc(state.title)}" />
      </div>
      <div class="mb-3">
        <label class="label"><span class="label-text">Tags</span></label>
        <input class="input input-bordered w-full" type="text" name="tags" value="${esc(state.tags)}" />
      </div>
      <div class="mb-3">
        <label class="label"><span class="label-text">Body</span></label>
        <textarea class="textarea textarea-bordered w-full" name="body" rows="14">${esc(state.body)}</textarea>
      </div>
      <button type="submit" class="btn btn-primary btn-sm">${state.isNew ? 'Create' : 'Save'}</button>
    </form>
    ${deleteBtn}
  </div>`;
}

export function renderKbEditorEmpty(): string {
  return '<p class="text-base-content/60 text-sm">Select a note on the left, or click &quot;New note&quot;.</p>';
}

export function renderErrorFragment(message: string): string {
  return `<div class="alert alert-error text-sm"><span>${esc(message)}</span></div>`;
}

// --- Messages fragments ---

export function renderMessagesList(messages: MessageRow[]): string {
  if (messages.length === 0) return '<p class="text-base-content/60 text-sm p-2">No messages.</p>';
  return messages
    .map((m) => {
      const to = m.to_name ? esc(m.to_name) : '<span class="badge badge-error badge-sm">BROADCAST</span>';
      const urgent = m.urgent ? '<span class="badge badge-warning badge-sm">URGENT</span>' : '';
      return `<div class="card bg-base-200 p-3 mb-2" id="msg-${m.id}">
        <div class="flex justify-between items-start gap-2 mb-1">
          <span class="text-xs text-base-content/60">${esc(m.from_name)} &rarr; ${to} ${urgent} &middot; ${esc(fmtTime(m.created_at))}</span>
          <button class="btn btn-error btn-xs" hx-delete="/api/v1/admin/messages/${m.id}" hx-target="#msg-${m.id}" hx-swap="outerHTML"
            hx-confirm="Delete message #${m.id}?">Delete</button>
        </div>
        <div class="whitespace-pre-wrap break-words text-sm">${esc(m.body)}</div>
      </div>`;
    })
    .join('');
}

// --- Page shell ---
// CDN versions pinned as of writing (all fetched and confirmed live): htmx.org 2.0.10,
// alpinejs 3.15.12, flyonui 2.4.1 (ships flat as flyonui.css/flyonui.js, no dist/ subpath),
// Tailwind Play CDN 3.4.17. Bump these in one place if a future FlyonUI/Tailwind major changes
// class names — nothing else in this file needs to change. Each tag carries a SHA-384 `integrity`
// hash (computed against the exact pinned URL above) + `crossorigin="anonymous"` so a compromised
// CDN can't silently swap in different script content.
export const ADMIN_HTML = `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>cc_hub admin</title>
<script src="https://cdn.tailwindcss.com/3.4.17"
  integrity="sha384-igm5BeiBt36UU4gqwWS7imYmelpTsZlQ45FZf+XBn9MuJbn4nQr7yx1yFydocC/K" crossorigin="anonymous"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/flyonui@2.4.1/flyonui.css"
  integrity="sha384-ZC0+/vCCDn/Cnx9wDjR5RgANEw9DQdMaoUb0xu50kHnnfgoNH7kqv6JvBjRM17q1" crossorigin="anonymous" />
<script src="https://unpkg.com/htmx.org@2.0.10/dist/htmx.min.js" defer
  integrity="sha384-H5SrcfygHmAuTDZphMHqBJLc3FhssKjG7w/CeCpFReSfwBWDTKpkzPP8c+cLsK+V" crossorigin="anonymous"></script>
<script src="https://cdn.jsdelivr.net/npm/alpinejs@3.15.12/dist/cdn.min.js" defer
  integrity="sha384-pb6hrQvo4s23cEUFtj0CZkzGE3jyK3pj26RIupXXxhSrrcUA/Cn0lZgcCrGH0t6L" crossorigin="anonymous"></script>
<script src="https://cdn.jsdelivr.net/npm/flyonui@2.4.1/flyonui.js" defer
  integrity="sha384-+tCpURq0igGAGVJ1XcjcPENKbudE28m+vCLirmCeYu62DAwJ1w25lDKDprCLaY06" crossorigin="anonymous"></script>
</head>
<body class="min-h-screen bg-base-300 text-base-content" x-data="{ tab: 'athen' }">

<header class="navbar bg-base-200 border-b border-base-content/10 px-4 gap-3 sticky top-0 z-10">
  <div class="flex-1 font-semibold">cc_hub admin</div>
  <div class="flex items-center gap-2" x-data="{ token: localStorage.getItem('ccHubToken') || '' }">
    <input type="password" x-model="token" placeholder="Bearer token" autocomplete="off"
      class="input input-bordered input-sm w-48" />
    <button type="button" class="btn btn-primary btn-sm"
      @click="localStorage.setItem('ccHubToken', token); document.getElementById('bad-token-alert').classList.add('hidden'); htmx.trigger(document.body, 'kb-changed'); htmx.trigger(document.body, 'msg-changed')">
      Save token
    </button>
  </div>
</header>

<div id="bad-token-alert" class="alert alert-error mx-4 mt-3 hidden">
  <span>Bad token &mdash; paste the authToken from config.json above and click Save token.</span>
</div>

<nav class="tabs tabs-boxed mx-4 mt-3 w-fit">
  <button type="button" class="tab" :class="tab === 'athen' ? 'tab-active' : ''" @click="tab = 'athen'">Athen</button>
  <button type="button" class="tab" :class="tab === 'messages' ? 'tab-active' : ''" @click="tab = 'messages'">Messages</button>
</nav>

<main class="p-4 max-w-5xl mx-auto">

  <section x-show="tab === 'athen'">
    <div class="flex flex-wrap gap-2 mb-3">
      <input type="search" name="q" placeholder="Search Athen by meaning or keyword..."
        class="input input-bordered input-sm flex-1 min-w-[200px]"
        hx-get="/api/v1/admin/kb-search" hx-trigger="keyup changed delay:400ms, search" hx-target="#kb-list" hx-swap="innerHTML" />
      <button type="button" class="btn btn-sm" hx-get="/api/v1/admin/kb-list" hx-target="#kb-list" hx-swap="innerHTML">Recent</button>
      <button type="button" class="btn btn-sm btn-primary" hx-get="/api/v1/admin/kb-new" hx-target="#kb-editor" hx-swap="innerHTML">New note</button>
    </div>
    <div class="grid grid-cols-1 md:grid-cols-[320px_1fr] gap-4">
      <div class="card bg-base-200 p-3 max-h-[70vh] overflow-y-auto"
           id="kb-list" hx-get="/api/v1/admin/kb-list" hx-trigger="load, kb-changed from:body" hx-target="this" hx-swap="innerHTML">
        <p class="text-base-content/60 text-sm">Loading...</p>
      </div>
      <div class="card bg-base-200 p-4" id="kb-editor">
        <p class="text-base-content/60 text-sm">Select a note on the left, or click "New note".</p>
      </div>
    </div>
  </section>

  <section x-show="tab === 'messages'">
    <p class="text-base-content/60 text-sm mb-3">Deleting an unread broadcast stops it being delivered to remaining instances.</p>
    <div class="mb-3">
      <button type="button" class="btn btn-sm" hx-get="/api/v1/admin/messages-list" hx-target="#msg-list" hx-swap="innerHTML">Refresh</button>
    </div>
    <div id="msg-list" hx-get="/api/v1/admin/messages-list" hx-trigger="load, msg-changed from:body" hx-target="this" hx-swap="innerHTML">
      <p class="text-base-content/60 text-sm">Loading...</p>
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
