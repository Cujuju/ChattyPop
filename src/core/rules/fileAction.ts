// Appends Markdown or JSON Lines to owner-selected files. Run claims prevent duplicates; crashes after claiming can skip writes.
import { appendFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { hasRuleFileExtension } from '@shared/ruleKinds/host';
import type { FileConfig } from '@shared/ruleKinds/host';
import type { Db } from '../db';
import { messageValues } from '../queries/messageContent';
import type { ActionResult } from './actions';
import type { FireContext } from './hostActions';

type FileAction = FileConfig;

/** What a file line says about the message. */
export interface FileEntry {
  rule: string;
  messageId: string;
  channelId: string;
  channel: string | null;
  authorId: string;
  author: string;
  ts: number;
  text: string;
  jump: string;
}

/** Local "YYYY-MM-DD HH:mm", as the owner reads times. */
function localMinute(ms: number): string {
  const d = new Date(ms);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** One line per message: its line breaks become spaces. */
const oneLine = (s: string): string => s.replace(/\s*\r?\n\s*/g, ' ').trim();

export function formatEntry(e: FileEntry, format: FileAction['format']): string {
  if (format === 'jsonl') return `${JSON.stringify({ ...e, at: new Date(e.ts).toISOString() })}\n`;
  const where = e.channel ? ` · #${e.channel}` : '';
  return `- ${localMinute(e.ts)}${where} · ${e.author}: ${oneLine(e.text)} ([open](${e.jump}))\n`;
}

export async function fileAction(
  db: Db,
  a: FileAction,
  { rule, m }: Pick<FireContext, 'rule' | 'm'>,
): Promise<ActionResult> {
  const path = a.path.trim();
  // Checked on save too; a stored spec is re-checked here before anything is written.
  if (!isAbsolute(path) || !hasRuleFileExtension(path, a.format))
    return { outcome: 'failed', detail: 'The file path is not allowed; pick the file again.' };
  const values = messageValues(db, m.id);
  if (!values) return { outcome: 'skipped', detail: 'The message is no longer stored.' };
  const channel = db.prepare('SELECT name FROM channels WHERE id = ?').pluck().get(m.channelId) as string | undefined;
  const entry: FileEntry = {
    rule: rule.name,
    messageId: m.id,
    channelId: m.channelId,
    channel: channel ?? null,
    authorId: m.authorId,
    author: values.author,
    ts: m.ts,
    text: m.content,
    jump: values.jump,
  };
  await appendInOrder(path, formatEntry(entry, a.format)); // creates the file, not its folder; a throw is recorded as failed
  return { outcome: 'done', detail: null };
}

/** The last queued append per file. Concurrent appends complete in OS order, so each waits for the one before it. */
const appendTails = new Map<string, Promise<void>>();

/** Appends after every earlier append to the same file, in call order. Keys fold case: over-serializing is harmless. */
function appendInOrder(path: string, text: string): Promise<void> {
  const key = resolve(path).toLowerCase();
  const append = (appendTails.get(key) ?? Promise.resolve()).then(() => appendFile(path, text, 'utf8'));
  const tail = append.catch(() => undefined);
  appendTails.set(key, tail);
  void tail.then(() => {
    if (appendTails.get(key) === tail) appendTails.delete(key);
  });
  return append;
}
