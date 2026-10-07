// The double-tap reaction's emoji (Settings → Phone, through the plugin kit): the choice drawn, and the picker that changes it.
import { Show, onMount } from 'solid-js';
import type { ArchiveEmoji } from '@shared/contract';
import { DM_GUILD_ID } from '@shared/discord';
import { EmojiImage } from '@/ui/AnimatedImage';
import { changeDeviceChatSettings } from '@/state/chatSettings';
import { ensureExpressions } from '@/state/expressions';
import { asReaction } from '@/state/reactions';
import { look } from '@/theme/look';
import { EmojiList } from '@/panels/chat/compose/EmojiList';

/** A reaction emoji at reaction size: Unicode text or a custom emoji's image. */
export function ChatEmoji(props: { emoji: ArchiveEmoji }) {
  return (
    <Show when={props.emoji.id} fallback={<span class={look.emojiGlyph}>{props.emoji.name}</span>}>
      {(id) => <EmojiImage class={look.emojiGlyph} emoji={{ id: id(), animated: props.emoji.animated }} alt={`:${props.emoji.name}:`} />}
    </Show>
  );
}

/** Every emoji the owner can react with anywhere (a DM's choice: Unicode, and custom ones their plan allows); a pick becomes the double-tap reaction. */
export function DoubleTapEmojiPicker(props: { onPicked: () => void }) {
  onMount(() => ensureExpressions(DM_GUILD_ID));
  return (
    <EmojiList
      guildId={DM_GUILD_ID}
      onPick={(pick) => {
        void changeDeviceChatSettings({ doubleTapEmoji: asReaction(pick) });
        props.onPicked();
      }}
    />
  );
}
