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
});
