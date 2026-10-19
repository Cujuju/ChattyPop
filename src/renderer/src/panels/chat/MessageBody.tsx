import { For, Show, createMemo } from 'solid-js';
import type { ArchiveMessage } from '@shared/contract';
import { embedMediaReplacesLink } from '@shared/chatSettings';
import { coverageText } from '@/plugins/presentation';
import { discordChatSettings, spoilersShownIn } from '@/state/chatSettings';
import { messageLink } from '@/state/messageActions';
import { pluginPresents } from '@/state/plugins';
import { clockTime as time } from '@/ui/format';
import { Markdown } from '@/ui/Markdown';
import { isEmojiOnly, senderSpoilerLinks } from '@/ui/mdParse';
import { SpoilerMessage, SpoilersShown } from '@/ui/spoilers';
import { look } from '@/theme/look';
import { Note } from './Attachment';
import { Attachments } from './Attachments';
import { MessageComponents } from './MessageComponents';
import { MessageEditor } from './MessageEditor';
import { Embeds, Reactions, Stickers, textIsEmbedLink } from './MessageExtras';
import { presentedParts } from './ownedParts';
import { Poll } from './Poll';
import { PollResult } from './PollResult';
import styles from './MessageRow.module.css';

/** Discord shows up to this many emoji large when a message has nothing else. */
const MAX_JUMBO_EMOJI = 27;

/** Deletion note, text with edit mark (or the owner's editor), earlier revisions and attachments: shared by both layouts. */
export function MessageBody(props: { message: ArchiveMessage; editing: boolean }) {
  const m = () => props.message;
  // A loaded message may outlive its parts' owners: their chips and notes leave with them.
  const senderLinks = createMemo(() => senderSpoilerLinks(m().content));
  const labels = () => presentedParts(m().labels, pluginPresents);
  const chat = discordChatSettings;
  /** The text is just the link its media-only embed shows, and that embed's media shows: Discord hides the text. */
  const textIsShownLink = (): boolean => embedMediaReplacesLink(chat()) && textIsEmbedLink(m().content, m().embeds);
  return (
    <SpoilersShown.Provider value={() => spoilersShownIn(m().channelId)}>
      <SpoilerMessage.Provider value={() => ({ id: m().id, senderLinks: senderLinks() })}>
        <div class={styles.body}>
          <Show when={m().deletedAt}>{(at) => <p class={styles.deletedNote}>Deleted by author {time(at())} · original kept in archive</p>}</Show>
          <Show when={labels().length}>
            <span class={styles.labels}>
              <For each={labels()}>
                {(l) => (
                  <span
                    class={`${styles.tag} ${look.tag}`}
                    data-tag={l.pluginId ? undefined : l.text.toLowerCase()}
                    data-own={l.variant}
                    title={l.title}
                  >
                    {l.text}
                  </span>
                )}
              </For>
            </span>
          </Show>
          <Show when={m().prunedAt}>{(at) => <p class={styles.deletedNote}>Text removed {time(at())} by text retention · {coverageText().covered}</p>}</Show>
          <Show when={!props.editing} fallback={<MessageEditor />}>
            <Show when={m().content && !textIsShownLink()}>
              <p class={styles.content}>
                <Markdown text={m().content} mentions={m().mentions} jumbo={isEmojiOnly(m().content, MAX_JUMBO_EMOJI)} />
                <Show when={m().editedTs}>{(at) => <span class={styles.editedMark}> (edited {time(at())})</span>}</Show>
              </p>
            </Show>
          </Show>
          <For each={m().revisions}>
            {(r) => (
              <div class={styles.revision}>
                <span class={styles.revisionLabel}>was</span>
                <p class={styles.revisionText}>
                  <Markdown text={r.content} mentions={m().mentions} />
                </p>
              </div>
            )}
          </For>
          <For each={presentedParts(m().annotations, pluginPresents)}>
            {(a) => (
              <div class={styles.revision} data-kind="annotation" title={`From plugin ${a.pluginId}`}>
                <span class={styles.revisionLabel}>{a.label}</span>
                <p class={styles.revisionText}>{a.text}</p>
              </div>
            )}
          </For>
          {/* Notes on links no card shows (a linked post's translation). */}
          <For each={presentedParts(m().notes ?? [], pluginPresents)}>{(n) => <Note note={n} />}</For>
          <Attachments message={m()} messageLink={messageLink(m())} />
          <Stickers stickers={m().stickers} />
          <Show when={chat().renderEmbeds}>
            <Embeds embeds={m().embeds} mentions={m().mentions} hideMedia={!chat().inlineLinkMedia} />
          </Show>
          <MessageComponents message={m()} />
          <Show when={m().poll}>
            <Poll message={m()} />
          </Show>
          <Show when={m().pollResult}>
            <PollResult message={m()} />
          </Show>
          <Show when={chat().renderReactions}>
            <Reactions message={m()} />
          </Show>
        </div>
      </SpoilerMessage.Provider>
    </SpoilersShown.Provider>
  );
}
