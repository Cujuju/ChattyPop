// A reaction's who-reacted tip, as Discord's: the emoji large beside ":name: reacted by A, B and 3 others". The first
// reactors come from core's cache while the reaction's count still matches, else from Discord.
import { createMemo } from 'solid-js';
import type { ArchiveMessage, ArchiveReaction } from '@shared/contract';
import { api } from '@/api';
import { cachedThenLive } from '@/state/cachedLive';
import { PeopleTip } from './HoverTip';

export function ReactionTip(props: { message: ArchiveMessage; reaction: ArchiveReaction; anchor: HTMLElement }) {
  const r = () => props.reaction;
  // A plain emoji: the message's is a store proxy, which IPC can't clone.
  const key = createMemo(() => {
    const { id, name, animated } = r().emoji;
    return { channelId: props.message.channelId, messageId: props.message.id, emoji: { id, name, animated }, count: r().count };
  });
  const reactors = cachedThenLive(
    key,
    (k) => api.core.reactors(k.messageId, k.emoji.id ?? k.emoji.name),
    (k) => api.discord.reactors(k.channelId, k.messageId, k.emoji, k.count),
    // A cached list whose count still matches is current: reacting changes the count.
    (copy, k) => !copy || copy.count !== k.count,
  );
  return (
    <PeopleTip
      anchor={props.anchor}
      emoji={key().emoji}
      label={`:${r().emoji.name}:`}
      verb="reacted by"
      people={reactors.value()?.people ?? null}
      count={r().count}
      channelId={props.message.channelId}
      status={reactors.stale() ? `${r().count} reacted · Discord couldn't be reached` : 'Loading…'}
    />
  );
}
