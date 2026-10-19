// One Archive-rendered conversation row with the owner's marks and an action to add an unlinked message.
import type { ArchiveMessage, ConversationMark, ConversationMember } from '@shared/contract';
import { cutText } from '@shared/text';
import { Match, Show, Switch } from 'solid-js';
import { archiveDensity, openArchive } from '@/state/archive';
import { markConversationMessage, recentMarks } from '@/state/conversation';
import { countText } from '@/ui/format';
import { MessageRow } from '@/ui/MessageRow';
import { SolidIcon } from '@/ui/solidIcons';
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
  grouped: boolean;
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
      data-root={props.root}
    >
      <MessageRow message={m()} density={archiveDensity()} focused={false} conversationButton={false} grouped={props.grouped} />
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
            <button type="button" class="cp-button" aria-label="Add to conversation" title="It continues this conversation but wasn’t linked" onClick={() => mark('add')}>
              <SolidIcon name="plus" />
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
        <button type="button" class="cp-button" aria-label="Open in the Archive" title="Open in the Archive" onClick={() => void openArchive(m().channelId, m().id)}>
          <SolidIcon name="archive" />
        </button>
      </div>
    </li>
  );
}
