import { For, Show, onMount } from 'solid-js';
import type { ArchiveEmoji, ArchiveMessage } from '@shared/contract';
import { DM_GUILD_ID } from '@shared/discord';
import { emojiUrl } from '@shared/emoji';
import { channelById } from '@/state/directory';
import { loadExpressions } from '@/state/expressions';
import { prepareQuickReactions, quickReactions } from '@/state/quickReactions';
import { openReactionPicker, react, reactedWith } from '@/state/reactions';
import { setContextMenu } from '@/state/ui';
import { SolidIcon } from '@/ui/solidIcons';
import styles from './QuickReactions.module.css';

/** Emoji before the More button: Discord's phone sheet shows six. */
const QUICK_REACTIONS_MAX = 6;

/**
 * The quick reactions atop a message's menu: the owner's most-used reactions that work in this channel (state/quickReactions),
 * then More for the full picker. One the owner already reacted with shows pressed; a tap takes it back.
 */
export function QuickReactions(props: { message: ArchiveMessage; x: number; y: number }) {
  onMount(() => {
    // Opening the menu refreshes the catalog, so emoji added since show up.
    loadExpressions(channelById(props.message.channelId)?.guildId ?? DM_GUILD_ID);
    prepareQuickReactions(props.message);
  });
  const emojis = (): ArchiveEmoji[] => quickReactions(props.message, QUICK_REACTIONS_MAX);
  const pick = (emoji: ArchiveEmoji): void => {
    setContextMenu(null);
    react(props.message, emoji, !reactedWith(props.message, emoji));
  };
  const more = (): void => {
    setContextMenu(null);
    openReactionPicker(props.message, props.x, props.y);
  };

  return (
    <div class={styles.row} role="group" aria-label="Quick reactions">
      <For each={emojis()}>
        {(e) => (
          <button type="button" class={styles.emoji} aria-pressed={reactedWith(props.message, e)} aria-label={`React with ${e.id ? `:${e.name}:` : e.name}`} title={e.id ? `:${e.name}:` : e.name} onClick={() => pick(e)}>
            <Show when={e.id} fallback={<span class={styles.glyph}>{e.name}</span>}>
              {(id) => <img class={styles.image} src={emojiUrl({ id: id(), animated: e.animated })} alt="" />}
            </Show>
          </button>
        )}
      </For>
      <button type="button" class={styles.emoji} aria-label="More reactions" title="More reactions" onClick={more}>
        <SolidIcon name="addReaction" class={styles.icon} />
      </button>
    </div>
  );
}
