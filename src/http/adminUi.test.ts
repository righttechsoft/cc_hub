import { describe, expect, it } from 'vitest';
import {
  esc,
  renderErrorFragment,
  renderInstanceApps,
  renderKbEditorEmpty,
  renderKbForm,
  renderKbList,
  renderKbSearchResults,
  renderMessagesList,
} from './adminUi.js';
import type { InstanceAppJoined, KbNoteRow, KbSearchResult, MessageRow } from '../types.js';

function note(overrides: Partial<KbNoteRow> = {}): KbNoteRow {
  return {
    id: 1,
    title: 'A note',
    body: 'the body',
    tags: 'x y',
    author_name: 'admin',
    created_at: 1000,
    updated_at: 2000,
    ...overrides,
  };
}

function message(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: 1,
    from_name: 'alpha',
    to_name: null,
    body: 'hello',
    urgent: 0,
    created_at: 1000,
    summary: null,
    ...overrides,
  };
}

describe('esc', () => {
  it('escapes HTML metacharacters', () => {
    expect(esc(`<script>alert(1)</script> & "quoted" 'single'`)).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quoted&quot; &#39;single&#39;'
    );
  });

  it('treats null/undefined as empty string', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });
});

describe('renderKbList', () => {
  it('escapes a hostile title so it never renders as markup', () => {
    const html = renderKbList([note({ title: '<script>alert(1)</script>' })]);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('renders an empty-state message for no notes', () => {
    expect(renderKbList([])).toContain('no notes yet');
  });

  it('includes an hx-get pointing at the note edit fragment route', () => {
    const html = renderKbList([note({ id: 42 })]);
    expect(html).toContain('hx-get="/api/v1/admin/kb-edit/42"');
  });
});

describe('renderKbSearchResults', () => {
  it('escapes hostile content in title/tags/snippet', () => {
    const result: KbSearchResult = {
      id: 1,
      title: '<img src=x onerror=alert(1)>',
      tags: '<b>tag</b>',
      snippet: '<i>snippet</i>',
      rank: 0,
    };
    const html = renderKbSearchResults([result]);
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<b>tag</b>');
    expect(html).not.toContain('<i>snippet</i>');
  });

  it('renders an empty-state message for no results', () => {
    expect(renderKbSearchResults([])).toContain('No matches');
  });
});

describe('renderKbForm', () => {
  it('escapes title/tags/body into input values and textarea content', () => {
    const html = renderKbForm({
      id: 1,
      title: '"><script>alert(1)</script>',
      tags: 'x',
      body: '<script>evil()</script>',
      authorName: 'admin',
      updatedAt: 1000,
      isNew: false,
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<script>evil()</script>');
    expect(html).toContain('&lt;script&gt;evil()&lt;/script&gt;');
  });

  it('new-note form posts to /api/v1/admin/kb and has no delete button', () => {
    const html = renderKbForm({ title: '', tags: '', body: '', isNew: true });
    expect(html).toContain('hx-post="/api/v1/admin/kb"');
    expect(html).not.toContain('hx-delete');
    expect(html).toContain('>Create note<');
  });

  it('existing-note form puts to /api/v1/admin/kb/:id and has a delete button', () => {
    const html = renderKbForm({ id: 7, title: 't', tags: '', body: 'b', isNew: false });
    expect(html).toContain('hx-put="/api/v1/admin/kb/7"');
    expect(html).toContain('hx-delete="/api/v1/admin/kb/7"');
    expect(html).toContain('>Save changes<');
  });

  it('shows an escaped error message when given one', () => {
    const html = renderKbForm({ title: 't', tags: '', body: 'b', isNew: true, error: '<b>bad</b>' });
    expect(html).toContain('&lt;b&gt;bad&lt;/b&gt;');
    expect(html).not.toContain('<b>bad</b>');
  });
});

describe('renderKbEditorEmpty / renderErrorFragment', () => {
  it('renders a placeholder', () => {
    expect(renderKbEditorEmpty()).toContain('Select a note');
  });

  it('escapes the error message', () => {
    expect(renderErrorFragment('<script>x</script>')).toContain('&lt;script&gt;x&lt;/script&gt;');
  });
});

function app(overrides: Partial<InstanceAppJoined> = {}): InstanceAppJoined {
  return {
    id: 1,
    instance_id: 1,
    instance_name: 'alpha',
    label: 'localhost:5173',
    url: 'http://localhost:5173',
    updated_at: 2000,
    ...overrides,
  };
}

describe('renderInstanceApps', () => {
  it('renders a web app as a brass link with the instance name', () => {
    const html = renderInstanceApps([app()]);
    expect(html).toContain('href="http://localhost:5173"');
    expect(html).toContain('localhost:5173');
    expect(html).toContain('alpha');
    expect(html).toContain('target="_blank"');
  });

  it('renders a desktop app (url null) as plain text, without an anchor', () => {
    const html = renderInstanceApps([app({ label: 'desktop app', url: null })]);
    expect(html).not.toContain('<a ');
    expect(html).toContain('desktop app');
  });

  it('escapes a hostile instance name and label', () => {
    const html = renderInstanceApps([
      app({ instance_name: '<script>alert(1)</script>', label: '<b>evil</b>', url: null }),
    ]);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<b>evil</b>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;evil&lt;/b&gt;');
  });

  it('renders a non-http(s) url as a plain label, without an anchor and without leaking the url text', () => {
    const html = renderInstanceApps([app({ url: 'javascript:alert(1)' })]);
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('javascript:alert(1)');
    expect(html).toContain('localhost:5173'); // falls back to showing the label, same as a desktop app
  });

  it('groups multiple apps under one instance', () => {
    const html = renderInstanceApps([
      app({ id: 1, label: 'localhost:3000', url: 'http://localhost:3000' }),
      app({ id: 2, label: 'localhost:4000', url: 'http://localhost:4000' }),
    ]);
    expect((html.match(/alpha/g) || []).length).toBe(1);
    expect(html).toContain('localhost:3000');
    expect(html).toContain('localhost:4000');
  });

  it('keeps separate instances as separate groups', () => {
    const html = renderInstanceApps([app({ instance_name: 'alpha' }), app({ instance_name: 'beta', id: 2 })]);
    expect(html).toContain('alpha');
    expect(html).toContain('beta');
  });

  it('returns an empty string when there are no rows', () => {
    expect(renderInstanceApps([])).toBe('');
  });
});

describe('renderMessagesList', () => {
  it('escapes a hostile message body', () => {
    const html = renderMessagesList([message({ body: '<script>alert(1)</script>' })]);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('shows BROADCAST for a null to_name and the name otherwise', () => {
    const broadcastHtml = renderMessagesList([message({ to_name: null })]);
    expect(broadcastHtml).toContain('BROADCAST');

    const directHtml = renderMessagesList([message({ to_name: 'bravo' })]);
    expect(directHtml).not.toContain('BROADCAST');
    expect(directHtml).toContain('bravo');
  });

  it('includes an hx-delete pointing at the message fragment route', () => {
    const html = renderMessagesList([message({ id: 9 })]);
    expect(html).toContain('hx-delete="/api/v1/admin/messages/9"');
    expect(html).toContain('id="msg-9"');
  });

  it('renders an empty-state message for no messages', () => {
    expect(renderMessagesList([])).toContain('No messages.');
  });
});
