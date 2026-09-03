import { describe, expect, it } from 'vitest';
import {
  esc,
  newestSessionPerCwd,
  renderErrorFragment,
  renderInstanceApps,
  renderKbEditorEmpty,
  renderKbForm,
  renderKbList,
  renderKbSearchResults,
  renderMessagesList,
  renderOverlordAnswer,
  renderOverlordConfirm,
  renderOverlordDispatched,
  renderOverlordDispatchConfirm,
  renderOverlordReplies,
  renderOverlordSent,
  renderSessionsList,
} from './adminUi.js';
import type { SessionListItem } from './adminUi.js';
import type { InstanceAppJoined, KbNoteRow, KbSearchResult, MessageRow } from '../types.js';
import type { OverlordAskTarget, OverlordCandidate, OverlordDispatchResult, OverlordFindResult } from '../overlord/overlord.js';
import type { DispatchCandidate } from '../spawn/dispatcher.js';

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

function session(overrides: Partial<SessionListItem> = {}): SessionListItem {
  return {
    id: 'session-id',
    instance_id: 1,
    instance_name: 'alpha',
    cwd: '/proj/alpha',
    status: 'idle',
    last_event_at: 1000,
    last_prompt: null,
    attached: false,
    working: false,
    session_name: null,
    ...overrides,
  };
}

describe('newestSessionPerCwd', () => {
  it('keeps only the newer session id when two sessions share a cwd', () => {
    const sessions = [
      { id: 'old', cwd: '/proj/alpha', last_event_at: 100 },
      { id: 'new', cwd: '/proj/alpha', last_event_at: 200 },
    ];
    expect(newestSessionPerCwd(sessions)).toEqual(new Set(['new']));
  });

  it('keeps one id per distinct cwd', () => {
    const sessions = [
      { id: 'a', cwd: '/proj/alpha', last_event_at: 100 },
      { id: 'b', cwd: '/proj/beta', last_event_at: 100 },
    ];
    expect(newestSessionPerCwd(sessions)).toEqual(new Set(['a', 'b']));
  });

  it('keeps the single session for a cwd with only one session', () => {
    const sessions = [{ id: 'only', cwd: '/proj/alpha', last_event_at: 100 }];
    expect(newestSessionPerCwd(sessions)).toEqual(new Set(['only']));
  });

  it('keeps exactly one id when timestamps tie in the same cwd', () => {
    const sessions = [
      { id: 'a', cwd: '/proj/alpha', last_event_at: 100 },
      { id: 'b', cwd: '/proj/alpha', last_event_at: 100 },
    ];
    const result = newestSessionPerCwd(sessions);
    expect(result.size).toBe(1);
    expect(result.has('a') || result.has('b')).toBe(true);
  });
});

describe('renderSessionsList', () => {
  it('groups attached sessions first (newest first), then unattached (newest first), with group labels', () => {
    const sessions = [
      session({ instance_name: 'attached-old', attached: true, last_event_at: 100 }),
      session({ instance_name: 'unattached-new', attached: false, last_event_at: 400 }),
      session({ instance_name: 'attached-new', attached: true, last_event_at: 300 }),
      session({ instance_name: 'unattached-old', attached: false, last_event_at: 200 }),
    ];
    const html = renderSessionsList(sessions);

    expect(html).toContain('Open terminals');
    expect(html).toContain('Other sessions');
    expect(html).toContain('class="meta-line mb-1 group-label"');
    expect(html).toContain('class="meta-line mt-3 mb-1 group-label"');

    const order = [
      'attached-new',
      'attached-old',
      'unattached-new',
      'unattached-old',
    ].map((name) => html.indexOf(name));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every((i) => i >= 0)).toBe(true);
  });

  it('omits group labels when only attached sessions are present', () => {
    const html = renderSessionsList([session({ attached: true })]);
    expect(html).not.toContain('Open terminals');
    expect(html).not.toContain('Other sessions');
  });

  it('omits group labels when only unattached sessions are present', () => {
    const html = renderSessionsList([session({ attached: false })]);
    expect(html).not.toContain('Open terminals');
    expect(html).not.toContain('Other sessions');
  });

  it('renders an empty-state message for no sessions', () => {
    expect(renderSessionsList([])).toContain('No live sessions.');
  });

  it('includes an inline rename form posting to the rename route with the instance id and current name', () => {
    const html = renderSessionsList([session({ instance_id: 42, instance_name: 'wonkybox' })]);
    expect(html).toContain('hx-post="/api/v1/admin/instances/rename"');
    expect(html).toContain('hx-target="#sessions-list"');
    expect(html).toContain('name="id" value="42"');
    expect(html).toContain('name="newName" value="wonkybox"');
  });

  it('escapes a hostile instance name in the rename widget', () => {
    const html = renderSessionsList([session({ instance_name: '<script>alert(1)</script>' })]);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('shows the session name when present', () => {
    const html = renderSessionsList([session({ session_name: 'Fix login bug' })]);
    expect(html).toContain('Fix login bug');
  });

  it('omits any session-name element when null', () => {
    const withName = renderSessionsList([session({ session_name: 'Fix login bug' })]);
    const withoutName = renderSessionsList([session({ session_name: null })]);
    expect(withoutName.length).toBeLessThan(withName.length);
    expect(withoutName).not.toContain('Fix login bug');
  });

  it('escapes a hostile session name', () => {
    const html = renderSessionsList([session({ session_name: '<script>alert(1)</script>' })]);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('truncates a long session name to ~60 chars', () => {
    const long = 'a'.repeat(120);
    const html = renderSessionsList([session({ session_name: long })]);
    expect(html).not.toContain(long);
    expect(html).toContain('…');
  });
});

function candidate(overrides: Partial<OverlordCandidate> = {}): OverlordCandidate {
  return {
    sessionId: 'abcdef1234567890',
    instance_name: 'alpha',
    cwd: '/proj/alpha',
    status: 'idle',
    last_event_at: 1000,
    snippets: ['fixed the date bug in the calendar widget'],
    ...overrides,
  };
}

function overlordResult(overrides: Partial<OverlordFindResult> = {}): OverlordFindResult {
  return { answer: 'Session [1] matches your question.', candidates: [candidate()], ...overrides };
}

describe('renderOverlordAnswer', () => {
  it('escapes the answer text', () => {
    const html = renderOverlordAnswer(overlordResult({ answer: '<script>alert(1)</script>' }));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('reflows the answer into paragraphs on blank lines', () => {
    const html = renderOverlordAnswer(overlordResult({ answer: 'first paragraph\n\nsecond paragraph' }));
    expect(html).toContain('first paragraph');
    expect(html).toContain('second paragraph');
    expect((html.match(/<p /g) || []).length).toBe(2);
  });

  it('numbers candidates starting at [1]', () => {
    const html = renderOverlordAnswer(
      overlordResult({ candidates: [candidate({ sessionId: 'aaa' }), candidate({ sessionId: 'bbb' })] })
    );
    expect(html).toContain('[1]');
    expect(html).toContain('[2]');
  });

  it('clips candidate snippets to the first two', () => {
    const html = renderOverlordAnswer(
      overlordResult({ candidates: [candidate({ snippets: ['one', 'two', 'three'] })] })
    );
    expect(html).toContain('one');
    expect(html).toContain('two');
    expect(html).not.toContain('three');
  });

  it('escapes hostile candidate fields', () => {
    const html = renderOverlordAnswer(
      overlordResult({
        candidates: [candidate({ instance_name: '<b>x</b>', cwd: '<i>y</i>', snippets: ['<script>z</script>'] })],
      })
    );
    expect(html).not.toContain('<b>x</b>');
    expect(html).not.toContain('<i>y</i>');
    expect(html).not.toContain('<script>z</script>');
  });

  it('renders only the answer when there are no candidates', () => {
    const html = renderOverlordAnswer(overlordResult({ candidates: [] }));
    expect(html).toContain('Session [1] matches');
    expect(html).not.toContain('badge-brass');
  });

  it('shows a placeholder for an empty answer', () => {
    const html = renderOverlordAnswer(overlordResult({ answer: '', candidates: [] }));
    expect(html).toContain('No answer.');
  });

  it('puts a cited candidate ahead of an earlier uncited one, keeping its original label', () => {
    const candidates = [candidate({ sessionId: 'c1' }), candidate({ sessionId: 'c2' }), candidate({ sessionId: 'c3' }), candidate({ sessionId: 'c4' })];
    const html = renderOverlordAnswer(overlordResult({ answer: 'Session [3] matches your question.', candidates }));
    expect(html.indexOf('c3')).toBeLessThan(html.indexOf('c1'));
    expect(html).toContain('[3]');
    expect(html).toContain('<details');
    expect(html).toContain('Other candidates (3)');
  });

  it('orders cited candidates by citation order, not recency order', () => {
    const candidates = [candidate({ sessionId: 'c1' }), candidate({ sessionId: 'c2' })];
    const html = renderOverlordAnswer(overlordResult({ answer: 'See [2] and also [1].', candidates }));
    expect(html.indexOf('c2')).toBeLessThan(html.indexOf('c1'));
  });

  it('treats an out-of-range citation as no-op when no valid citations exist', () => {
    const candidates = [candidate({ sessionId: 'c1' }), candidate({ sessionId: 'c2' })];
    const html = renderOverlordAnswer(overlordResult({ answer: 'See [9].', candidates }));
    expect(html).not.toContain('<details');
    expect(html).toContain('c1');
    expect(html).toContain('c2');
  });

  it('includes a resume command and copy button on every candidate card', () => {
    const candidates = [candidate({ sessionId: 'fullsessionid123', cwd: '/proj/alpha' })];
    const html = renderOverlordAnswer(overlordResult({ answer: 'Session [1] matches.', candidates }));
    expect(html).toContain('cc-attach --resume fullsessionid123');
    expect(html).toContain('cd &quot;/proj/alpha&quot;');
    expect(html).toContain('data-copy=');
  });

  it('renders a flat list with no details block when the answer cites nothing', () => {
    const candidates = [candidate({ sessionId: 'c1' }), candidate({ sessionId: 'c2' })];
    const html = renderOverlordAnswer(overlordResult({ answer: 'No specific session found.', candidates }));
    expect(html).not.toContain('<details');
    expect(html.indexOf('c1')).toBeLessThan(html.indexOf('c2'));
  });
});

function askTarget(overrides: Partial<OverlordAskTarget> = {}): OverlordAskTarget {
  return { name: 'alpha', cwd: '/proj/alpha', ...overrides };
}

describe('renderOverlordConfirm', () => {
  it('escapes the message text', () => {
    const html = renderOverlordConfirm('<script>alert(1)</script>', [askTarget()]);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('includes one hidden targets input per target', () => {
    const html = renderOverlordConfirm('hello', [askTarget({ name: 'alpha' }), askTarget({ name: 'beta' })]);
    expect(html).toContain('<input type="hidden" name="targets" value="alpha" />');
    expect(html).toContain('<input type="hidden" name="targets" value="beta" />');
  });

  it('includes a hidden message input and a Send button posting to overlord-send', () => {
    const html = renderOverlordConfirm('do the thing', [askTarget()]);
    expect(html).toContain('<input type="hidden" name="message" value="do the thing" />');
    expect(html).toContain('hx-post="/api/v1/admin/overlord-send"');
    expect(html).toContain('hx-target="#overlord-answer"');
    expect(html).toContain('>Send<');
  });

  it('includes a Cancel button that does not post anywhere', () => {
    const html = renderOverlordConfirm('hi', [askTarget()]);
    expect(html).toContain('>Cancel<');
  });

  it('escapes hostile target name/cwd', () => {
    const html = renderOverlordConfirm('hi', [askTarget({ name: '<b>x</b>', cwd: '<i>y</i>' })]);
    expect(html).not.toContain('<b>x</b>');
    expect(html).not.toContain('<i>y</i>');
  });

  it('renders an error fragment instead of a form when there are no targets and none excluded', () => {
    const html = renderOverlordConfirm('hi', []);
    expect(html).not.toContain('hx-post="/api/v1/admin/overlord-send"');
    expect(html).toContain('alert-danger');
  });

  it('renders the excluded line, escaped, alongside the Send form', () => {
    const html = renderOverlordConfirm(
      'hi',
      [askTarget({ name: 'alpha' })],
      [askTarget({ name: '<b>dead</b>', cwd: '/proj/dead' })]
    );
    expect(html).toContain('Skipped 1 inactive instance(s)');
    expect(html).toContain('&lt;b&gt;dead&lt;/b&gt;');
    expect(html).not.toContain('<b>dead</b>');
    expect(html).toContain('including inactive');
    expect(html).toContain('hx-post="/api/v1/admin/overlord-send"');
  });

  it('omits the excluded line when nothing was excluded', () => {
    const html = renderOverlordConfirm('hi', [askTarget()], []);
    expect(html).not.toContain('Skipped');
  });

  it('renders a no-Send note (with the excluded list) when there are no live targets but some were excluded', () => {
    const html = renderOverlordConfirm('hi', [], [askTarget({ name: 'dead1' }), askTarget({ name: 'dead2' })]);
    expect(html).not.toContain('hx-post="/api/v1/admin/overlord-send"');
    expect(html).not.toContain('>Send<');
    expect(html).toContain('No matching instance is currently active');
    expect(html).toContain('Skipped 2 inactive instance(s)');
    expect(html).toContain('dead1');
    expect(html).toContain('dead2');
  });
});

describe('renderOverlordSent', () => {
  it('lists the sent-to targets', () => {
    const html = renderOverlordSent(['alpha', 'beta'], 42);
    expect(html).toContain('alpha');
    expect(html).toContain('beta');
  });

  it('renders a polling div carrying the afterId watermark', () => {
    const html = renderOverlordSent(['alpha'], 42);
    expect(html).toContain('hx-get="/api/v1/admin/overlord-replies?afterId=42"');
    expect(html).toContain('hx-trigger="load, every 3s"');
  });

  it('escapes a hostile target name', () => {
    const html = renderOverlordSent(['<script>alert(1)</script>'], 1);
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});

describe('renderOverlordReplies', () => {
  it('renders each reply as a card with sender, time, and escaped body', () => {
    const html = renderOverlordReplies([
      message({ id: 5, from_name: 'alpha', body: '<script>alert(1)</script>', created_at: Date.now() }),
    ]);
    expect(html).toContain('alpha');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('shows a muted "No replies yet" note when empty', () => {
    expect(renderOverlordReplies([])).toContain('No replies yet');
  });
});

function dispatchCandidate(overrides: Partial<DispatchCandidate> = {}): DispatchCandidate {
  return { name: 'wb-sync', cwd: '/proj/wb-sync', attached: true, working: false, ...overrides };
}

function dispatchResult(overrides: Partial<OverlordDispatchResult> = {}): OverlordDispatchResult {
  return {
    mode: 'dispatch',
    task: 'Implement the CSV export.',
    name: 'wb-sync',
    action: { kind: 'inject', name: 'wb-sync', cwd: '/proj/wb-sync' },
    candidates: [dispatchCandidate()],
    ...overrides,
  };
}

describe('renderOverlordDispatchConfirm', () => {
  it('states a reuse plan in plain words for an inject action', () => {
    const html = renderOverlordDispatchConfirm(dispatchResult());
    expect(html).toContain('Reuse the idle terminal');
    expect(html).toContain('wb-sync');
    expect(html).toContain('/proj/wb-sync');
  });

  it('states an open-new-tab plan in plain words for a spawn action', () => {
    const html = renderOverlordDispatchConfirm(
      dispatchResult({ action: { kind: 'spawn', name: 'fix-csv-export', cwd: '/proj/wb2' } })
    );
    expect(html).toContain('Open a NEW terminal tab');
    expect(html).toContain('fix-csv-export');
    expect(html).toContain('/proj/wb2');
  });

  it('escapes the task text', () => {
    const html = renderOverlordDispatchConfirm(dispatchResult({ task: '<script>alert(1)</script>' }));
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('lists candidates with their live/working state', () => {
    const html = renderOverlordDispatchConfirm(
      dispatchResult({
        candidates: [
          dispatchCandidate({ name: 'a', cwd: '/proj/a', attached: true, working: true }),
          dispatchCandidate({ name: 'b', cwd: '/proj/b', attached: false, working: false }),
        ],
      })
    );
    expect(html).toContain('working');
    expect(html).toContain('not attached');
  });

  it('includes hidden fields round-tripping the plan and a Dispatch button posting to overlord-dispatch', () => {
    const html = renderOverlordDispatchConfirm(dispatchResult());
    expect(html).toContain('hx-post="/api/v1/admin/overlord-dispatch"');
    expect(html).toContain('hx-target="#overlord-answer"');
    expect(html).toContain('<input type="hidden" name="action" value="inject" />');
    expect(html).toContain('<input type="hidden" name="name" value="wb-sync" />');
    expect(html).toContain('<input type="hidden" name="cwd" value="/proj/wb-sync" />');
    expect(html).toContain('<input type="hidden" name="task" value="Implement the CSV export." />');
    expect(html).toContain('>Dispatch<');
  });

  it('includes a Cancel button that does not post anywhere', () => {
    const html = renderOverlordDispatchConfirm(dispatchResult());
    expect(html).toContain('>Cancel<');
  });

  it('escapes a hostile candidate name/cwd', () => {
    const html = renderOverlordDispatchConfirm(
      dispatchResult({ candidates: [dispatchCandidate({ name: '<b>x</b>', cwd: '<i>y</i>' })] })
    );
    expect(html).not.toContain('<b>x</b>');
    expect(html).not.toContain('<i>y</i>');
  });
});

describe('renderOverlordDispatched', () => {
  it('renders a sent message for "injected"', () => {
    const html = renderOverlordDispatched('injected', 'wb-sync', '/proj/wb-sync', 'do the task');
    expect(html).toContain('Task sent to');
    expect(html).toContain('wb-sync');
  });

  it('renders an opened-and-sent message for "spawned"', () => {
    const html = renderOverlordDispatched('spawned', 'fix-csv-export', '/proj/wb2', 'do the task');
    expect(html).toContain('Opened a new tab');
    expect(html).toContain('fix-csv-export');
    expect(html).toContain('sent the task');
  });

  it('renders a manual-paste snippet with a copy button for "spawned_no_inject"', () => {
    const html = renderOverlordDispatched('spawned_no_inject', 'fix-csv-export', '/proj/wb2', 'Implement the CSV export.');
    expect(html).toContain('Paste the task manually');
    expect(html).toContain('Implement the CSV export.');
    expect(html).toContain('data-copy=');
    expect(html).toContain('copyText(this)');
  });

  it('renders an error fragment for "failed"', () => {
    const html = renderOverlordDispatched('failed', 'wb-sync', '/proj/wb-sync', 'task');
    expect(html).toContain('alert-danger');
  });

  it('escapes hostile name/task text', () => {
    const html = renderOverlordDispatched('spawned_no_inject', '<b>x</b>', '/proj', '<script>alert(1)</script>');
    expect(html).not.toContain('<b>x</b>');
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});
