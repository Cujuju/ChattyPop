// Discord's Forward: the message the Forward window is open for, where it may go, and sending it.
import { api } from '@/api';
import { createSignal } from 'solid-js';
import type { ArchiveMessage, DirectoryChannel } from '@shared/contract';
import { DISCORD_TEXT_MAX, FORUM_CHANNEL_TYPE, TEXT_CHANNEL_TYPES, newNonce } from '@shared/discord';
import { channelById, directory } from './directory';
import { onAppEvent } from './events';

/** One destination's sends for the open message: a retry reuses its nonces and never re-posts a forward that went. */
interface Attempt {
  nonce: string;
  posted: boolean;
  /** Note text → its nonce. */
  notes: Map<string, string>;
}

const [forwarding, setForwarding] = createSignal<ArchiveMessage | null>(null);
/** The message the Forward window is open for (startForward). */
export { forwarding };
/** By destination channel id; kept while the window is open for one message. */
let attempts = new Map<string, Attempt>();

/** Discord forwards no deleted message. */
export const canForward = (m: ArchiveMessage): boolean => m.deletedAt === null;
/**
 * Opens the Forward window on `m`: another message starts with no attempts; the open one keeps its own (a retry is pending).
 * The DM list needs no fetch: the client's gateway keeps it current.
 */
export const startForward = (m: ArchiveMessage): void => {
  if (forwarding()?.id !== m.id) attempts = new Map();
  setForwarding(m);
};
export const closeForward = (): void => void setForwarding(null);

/** The message the window is open for while its channel is shown: privacy mode hides the window with the channel. */
export const forwardSource = (): ArchiveMessage | null => {
  const m = forwarding();
  return m && channelById(m.channelId) ? m : null;
};
// A message can be hidden while its channel stays shown (it names a hidden one): core decides, so ask it again.
onAppEvent('privacy-changed', async () => {
  const m = forwarding();
  if (m && !(await api.core.messageById(m.id)) && forwarding() === m) closeForward();
});

/** A channel a forward can post to, with its server's name. */
export interface ForwardTarget {
  channel: DirectoryChannel;
  guildName: string;
}

/** Channels that take messages (a forum takes posts only), matching `query` by name, most recently active first. */
export function forwardTargets(query: string): ForwardTarget[] {
  const q = query.trim().toLowerCase();
  return directory()
    .flatMap((g) => g.channels.map((channel) => ({ channel, guildName: g.name })))
    .filter(({ channel: c }) => TEXT_CHANNEL_TYPES.has(c.kind) && c.kind !== FORUM_CHANNEL_TYPE && c.name.toLowerCase().includes(q))
    .sort((a, b) => (b.channel.lastTs ?? 0) - (a.channel.lastTs ?? 0));
}

/**
 * Forwards `m` to `channelId`, then posts `note` there as its own message when it has text, as Discord does; rejects with
 * Discord's reason. Retried after a failure, only what hasn't gone is sent, with the nonces of the first try.
 */
export async function forwardMessage(m: ArchiveMessage, channelId: string, note: string): Promise<void> {
  // Checked before anything goes: a note Discord refuses must not leave the forward posted without it.
  if (note.length > DISCORD_TEXT_MAX) throw new Error(`Discord allows ${DISCORD_TEXT_MAX} characters.`);
  const a = attempts.get(channelId) ?? { nonce: newNonce(), posted: false, notes: new Map<string, string>() };
  attempts.set(channelId, a);
  if (!a.posted) {
    const guildId = channelById(m.channelId)?.guildId ?? null;
    await api.discord.forward({ source: { channelId: m.channelId, messageId: m.id, guildId }, channelId, nonce: a.nonce });
    a.posted = true;
  }
  if (!note.trim()) return;
  const nonce = a.notes.get(note) ?? newNonce();
  a.notes.set(note, nonce);
  await api.discord.send({ channelId, text: note, replyTo: null, files: [], stickerId: null, gif: null, nonce });
}
