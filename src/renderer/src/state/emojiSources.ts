// Where a message's custom emoji comes from, for its popout: asked of main once per emoji, a failure asked again.
import { api } from '@/api';
import type { EmojiSource } from '@shared/emoji';

const asked = new Map<string, Promise<EmojiSource>>();

export function emojiSource(emojiId: string): Promise<EmojiSource> {
  const had = asked.get(emojiId);
  if (had) return had;
  const read = api.discord.emojiSource(emojiId);
  asked.set(emojiId, read);
  void read.catch(() => asked.get(emojiId) === read && asked.delete(emojiId));
  return read;
}
