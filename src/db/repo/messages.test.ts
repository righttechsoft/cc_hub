import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrations.js';
import * as messagesRepo from './messages.js';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

describe('messages repo', () => {
  it('markRead stores the via value when provided, and null when omitted', () => {
    const db = buildDb();
    const now = Date.now();
    const withVia = messagesRepo.send(db, { from: 'sender', to: 'recipient', body: 'a', urgent: false, now });
    const withoutVia = messagesRepo.send(db, { from: 'sender', to: 'recipient', body: 'b', urgent: false, now });

    messagesRepo.markRead(db, [withVia.id], 'recipient', now, 'chat_delivery');
    messagesRepo.markRead(db, [withoutVia.id], 'recipient', now);

    const rows = db
      .prepare('SELECT message_id, via FROM message_reads WHERE reader_name = ? ORDER BY message_id ASC')
      .all('recipient') as { message_id: number; via: string | null }[];

    expect(rows).toEqual([
      { message_id: withVia.id, via: 'chat_delivery' },
      { message_id: withoutVia.id, via: null },
    ]);
  });

  it('listChatDeliveredUnnotified returns only via=chat_delivery rows, regardless of age', () => {
    const db = buildDb();
    const now = Date.now();

    const delivered = messagesRepo.send(db, { from: 'sender', to: 'recipient', body: 'delivered', urgent: false, now });
    const manuallyRead = messagesRepo.send(db, { from: 'sender', to: 'recipient', body: 'manual', urgent: false, now });
    const veryOld = messagesRepo.send(db, { from: 'sender', to: 'recipient', body: 'stale', urgent: false, now });

    messagesRepo.markRead(db, [delivered.id], 'recipient', now, 'chat_delivery');
    messagesRepo.markRead(db, [manuallyRead.id], 'recipient', now); // via omitted — not chat_delivery
    messagesRepo.markRead(db, [veryOld.id], 'recipient', now - 365 * 24 * 60 * 60 * 1000, 'chat_delivery'); // a year old — still returned, no time window

    const result = messagesRepo.listChatDeliveredUnnotified(db, 'recipient');

    const numAsc = (a: number, b: number) => a - b;
    expect(result.map((m) => m.id).sort(numAsc)).toEqual([delivered.id, veryOld.id].sort(numAsc));
  });

  it('markChatDeliveryNotified makes rows disappear from a second listChatDeliveredUnnotified call (one-shot)', () => {
    const db = buildDb();
    const now = Date.now();

    const delivered = messagesRepo.send(db, { from: 'sender', to: 'recipient', body: 'delivered', urgent: false, now });
    messagesRepo.markRead(db, [delivered.id], 'recipient', now, 'chat_delivery');

    expect(messagesRepo.listChatDeliveredUnnotified(db, 'recipient')).toHaveLength(1);

    messagesRepo.markChatDeliveryNotified(db, [delivered.id], 'recipient');

    expect(messagesRepo.listChatDeliveredUnnotified(db, 'recipient')).toHaveLength(0);
  });

  it('setSummary updates the summary field for a message', () => {
    const db = buildDb();
    const now = Date.now();

    const message = messagesRepo.send(db, { from: 'a', to: 'b', body: 'text', urgent: false, now });
    expect(message.summary).toBeNull();

    messagesRepo.setSummary(db, message.id, 'fix bug');

    const updated = db.prepare('SELECT * FROM messages WHERE id = ?').get(message.id) as typeof message;
    expect(updated.summary).toBe('fix bug');
  });

  it('listUnsummarized returns only rows with NULL summary, oldest-first, respects sinceMs', () => {
    const db = buildDb();
    const now = Date.now();
    const old = now - 48 * 60 * 60 * 1000;

    const msg1 = messagesRepo.send(db, { from: 'a', to: 'b', body: 'first', urgent: false, now: old });
    const msg2 = messagesRepo.send(db, { from: 'a', to: 'b', body: 'second', urgent: false, now });
    const msg3 = messagesRepo.send(db, { from: 'a', to: 'b', body: 'third', urgent: false, now });

    messagesRepo.setSummary(db, msg2.id, 'already summarized');

    const window = now - 24 * 60 * 60 * 1000;
    const result = messagesRepo.listUnsummarized(db, window, 50);

    expect(result.map((m) => m.id)).toEqual([msg3.id]); // msg1 is outside window, msg2 is already summarized
  });

  it('listUnsummarized respects limit', () => {
    const db = buildDb();
    const now = Date.now();

    for (let i = 0; i < 10; i++) {
      messagesRepo.send(db, { from: 'a', to: 'b', body: `msg${i}`, urgent: false, now });
    }

    const result = messagesRepo.listUnsummarized(db, now - 1000, 3);
    expect(result).toHaveLength(3);
  });

  it('listRecentInvolving returns messages from, to, or broadcast to the name, newest first', () => {
    const db = buildDb();
    const now = Date.now();

    messagesRepo.send(db, { from: 'alice', to: 'bob', body: 'msg1', urgent: false, now });
    messagesRepo.send(db, { from: 'charlie', to: 'alice', body: 'msg2', urgent: false, now: now + 1000 });
    messagesRepo.send(db, { from: 'alice', to: null, body: 'broadcast', urgent: false, now: now + 2000 });
    messagesRepo.send(db, { from: 'dave', to: 'eve', body: 'unrelated', urgent: false, now: now + 3000 });

    const result = messagesRepo.listRecentInvolving(db, 'alice', 5, 0);

    expect(result.map((m) => m.body)).toEqual(['broadcast', 'msg2', 'msg1']);
  });

  it('listRecentInvolving respects sinceMs', () => {
    const db = buildDb();
    const now = Date.now();
    const old = now - 2000;

    messagesRepo.send(db, { from: 'alice', to: 'bob', body: 'old', urgent: false, now: old });
    messagesRepo.send(db, { from: 'alice', to: 'bob', body: 'new', urgent: false, now });

    const result = messagesRepo.listRecentInvolving(db, 'alice', 5, now - 1000);

    expect(result.map((m) => m.body)).toEqual(['new']);
  });

  it('listRecentInvolving respects limit', () => {
    const db = buildDb();
    const now = Date.now();

    for (let i = 0; i < 10; i++) {
      messagesRepo.send(db, { from: 'alice', to: 'bob', body: `msg${i}`, urgent: false, now: now + i });
    }

    const result = messagesRepo.listRecentInvolving(db, 'alice', 3);
    expect(result).toHaveLength(3);
  });
});
