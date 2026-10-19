// One message of the Conversation window, with the owner's marks: unsure links to confirm or remove, nearby messages to add.
import type { ArchiveMessage, ConversationMark, ConversationMember } from '@shared/contract';
import { cutText } from '@shared/text';
import { Match, Show, Switch } from 'solid-js';
import { openArchive } from '@/state/archive';
import { markConversationMessage, recentMarks } from '@/state/conversation';
import { openPerson } from '@/state/person';
import { clockTime, countText } from '@/ui/format';
import { Markdown } from '@/ui/Markdown';
import styles from './ConversationView.module.css';

/** Text kept with a mark for the removed list: one line's worth. */
export const MARK_SNIPPET_CHARS = 80;

const MARKED: Record<ConversationMark, string> = {
  belongs: 'You said it belongs',
  not: 'You said it isn’t part of this',
  add: 'You added it',
};

export const markedLabel = (mark: ConversationMark): string => MARKED[mark];

/** What a mark keeps about the message, so Undo still reads after the row is gone. */
export const markTarget = (m: ArchiveMessage) => ({ messageId: m.id, author: m.author.name, text: cutText(m.content, MARK_SNIPPET_CHARS) });

export function ConversationRow(props: {
  message: ArchiveMessage;
  member: ConversationMember | undefined;
  /** The owner's mark on it, member or not. */
  mark: ConversationMark | undefined;
  root: boolean;
  linked: boolean;
  anchor: boolean;
}) {
  const m = () => props.message;
  const mark = (value: ConversationMark | null) => void markConversationMessage(markTarget(m()), value);
  /** Discord linked it (reply, thread) or it starts the conversation: nothing to mark. */
  const fixed = () => !props.member || props.member.explicit || props.root;
  /** Its mark: stored, else one made here that core hasn't relinked yet. */
  const marked = () => props.mark ?? recentMarks().find((r) => r.messageId === m().id)?.mark ?? null;
  const notTitle = () => {
    const after = props.member?.branch ?? 0;
    return after ? `${countText(after, 'message')} continuing it leave with it.` : undefined;
  };
  return (
    <li
      class={styles.row}
      data-linked={props.linked}
      data-anchor={props.anchor}
      data-member={props.member !== undefined}
      data-questionable={!!props.member?.questionable && !marked()}
      data-mark={marked() ?? undefined}
    >
      <button type="button" class={styles.time} title="Open in the Archive" onClick={() => void openArchive(m().channelId, m().id)}>
        {clockTime(m().ts)}
      </button>
      <button type="button" class={styles.author} onClick={() => openPerson(m().author.id, m().channelId)}>
        {m().author.name}
      </button>
      <div class={styles.text}>
        <Show when={m().deletedAt}>
          <span class={styles.note}>deleted · </span>
        </Show>
        <Markdown text={m().content} mentions={m().mentions} />
        <Show when={m().attachments.length}>
          <span class={styles.note}> [{countText(m().attachments.length, 'attachment')}]</span>
        </Show>
      </div>
      <div class={styles.actions}>
        <Switch>
          <Match when={marked()}>
            {(value) => (
              <>
                <span class={styles.note}>{markedLabel(value())}</span>
                <button type="button" class="cp-button" onClick={() => mark(null)}>
                  Undo
                </button>
              </>
            )}
          </Match>
          <Match when={!props.member}>
            <button type="button" class="cp-button" title="It continues this conversation but wasn’t linked" onClick={() => mark('add')}>
              Add to conversation
            </button>
          </Match>
          <Match when={!fixed()}>
            <Show when={props.member?.questionable}>
              <span class={styles.badge}>Unsure</span>
              <button type="button" class="cp-button" onClick={() => mark('belongs')}>
                Belongs
              </button>
            </Show>
            <button type="button" class="cp-button" title={notTitle()} onClick={() => mark('not')}>
              Not part of this
            </button>
          </Match>
        </Switch>
      </div>
    </li>
  );
}
