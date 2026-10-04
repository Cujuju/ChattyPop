// A shipped migration: who each message pinged, for the sidebar's mention count. Discord's read states replaced it
// (read_states, the next migration, drops this table).
import type { Db } from '../db';

/**
 * Migration: the message_pings table. Its fill from stored payloads was removed: the next migration drops the table, so
 * a database that ran either version ends the same. Frozen.
 */
export function createMessagePings(db: Db): void {
  db.exec('CREATE TABLE message_pings (message_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (message_id, user_id)) WITHOUT ROWID');
}
