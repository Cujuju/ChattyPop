import { For, Show } from 'solid-js';
import type { ConversationView as Conversation } from '@shared/contract';
import {
  closeConversation,
  conversation,
  conversationFor,
  conversationMarkFailure,
  markConversationMessage,
  recentMarks,
  setShowNearby,
  showNearby,
} from '@/state/conversation';
import { countText, shortDate } from '@/ui/format';
import { FloatingWindow, WindowHeader } from '@/ui/FloatingWindow';
import chrome from '@/ui/WindowChrome.module.css';
import { canGroupMessage } from '@/ui/messageGrouping';
import { keyedRows } from '@/ui/keyedRows';
import { ConversationRow, markedLabel } from './ConversationRow';
import styles from './ConversationView.module.css';

const unsureCount = (c: Conversation): number => Object.entries(c.members).filter(([id, m]) => m.questionable && !c.marks[id]).length;
const shownMembers = (c: Conversation): number => Object.keys(c.members).length;
const hasUnlinked = (c: Conversation): boolean => c.messages.some((m) => !c.members[m.id]);

/** Member and unlinked rows keep separate author groups. */
const grouped = (c: Conversation, index: number): boolean => {
  const message = c.messages[index]!;
  const previous = c.messages[index - 1];
  return !!previous && !!c.members[previous.id] === !!c.members[message.id] && canGroupMessage(previous, message);
};

/** The owner's conversation window: Archive rows, link evidence, corrections and missed messages to add. */
export function ConversationView() {
  const rows = keyedRows(() => conversation()?.messages ?? []);
  const linked = (): Set<string> => new Set(conversation()?.linkedIds ?? []);
  /** Removed here and no longer shown: Undo lives in the list above the messages. */
  const removed = () => {
    const shown = new Set(conversation()?.messages.map((m) => m.id) ?? []);
    return recentMarks().filter((r) => r.mark === 'not' && !shown.has(r.messageId));
  };
  return (
    <FloatingWindow id="conversation" open={conversationFor() !== null} class={chrome.dialog} aria-label="Conversation" onClose={closeConversation}>
      <WindowHeader title="Conversation" classes={chrome} closeLabel="Close" onClose={closeConversation} />
      <div class={chrome.body}>
        <Show when={conversation.failure}>
          <p class="cp-error" role="alert">
            Couldn't load this conversation.
          </p>
        </Show>
        <Show when={conversationMarkFailure()}>
          {(why) => (
            <p class="cp-error" role="alert">
              Couldn't save that mark: {why()}
            </p>
          )}
        </Show>
        <Show when={conversation()}>
          {(c) => (
            <Show when={c().messages.length} fallback={<p class="cp-hint">This message isn't in the archive.</p>}>
              <p class="cp-hint">
                {shortDate(c().messages[0]!.ts)} · {countText(c().memberCount, 'message')} ·{' '}
                {/* linkedIds always holds the message itself; more than one means Discord replies joined others. */}
                {c().linkedIds.length > 1 ? `${c().linkedIds.length} joined by replies (marked)` : 'no replies'}; the rest linked by who answered whom.
              </p>
              <Show when={unsureCount(c())}>
                {(n) => <p class="cp-hint">{countText(n(), 'unsure link')}: say whether each belongs. Your marks set the links and teach the linker.</p>}
              </Show>
              <Show when={c().memberCount > shownMembers(c())}>
                <p class="cp-hint">Showing the {shownMembers(c())} messages nearest this one.</p>
              </Show>
              <Show when={c().pending}>
                <p class="cp-hint">Still linking this channel: the conversation may change.</p>
              </Show>
              <div class={styles.toolbar}>
                <button type="button" class="cp-button" aria-pressed={showNearby()} onClick={() => setShowNearby(!showNearby())}>
                  {showNearby() ? 'Hide later messages' : 'Show later messages'}
                </button>
                <Show when={hasUnlinked(c())}>
                  <span class="cp-hint">
                    Messages between them that weren’t linked are shown smaller: + adds one that belongs.
                    {showNearby() ? ' Later messages within reach are shown too.' : ''}
                    {c().unlinkedMore ? ' Only those nearest this message are shown.' : ''}
                  </span>
                </Show>
              </div>
              <Show when={removed().length}>
                <ul class={styles.removed} aria-label="Removed from this conversation">
                  <For each={removed()}>
                    {(r) => (
                      <li class={styles.removedRow}>
                        <span class={styles.note}>
                          {markedLabel(r.mark)}: {r.author} — {r.text}
                        </span>
                        <button type="button" class="cp-button" onClick={() => void markConversationMessage(r, null)}>
                          Undo
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <ol class={styles.list}>
                <For each={rows.ids()}>
                  {(id, index) => (
                    <ConversationRow
                      message={rows.item(id)!}
                      member={c().members[id]}
                      mark={c().marks[id]}
                      root={id === c().rootId}
                      linked={linked().has(id)}
                      anchor={id === conversationFor()}
                      grouped={grouped(c(), index())}
                    />
                  )}
                </For>
              </ol>
            </Show>
          )}
        </Show>
      </div>
    </FloatingWindow>
  );
}
