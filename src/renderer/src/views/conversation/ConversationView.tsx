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
import { ConversationRow, markedLabel } from './ConversationRow';
import styles from './ConversationView.module.css';

const unsureCount = (c: Conversation): number => Object.entries(c.members).filter(([id, m]) => m.questionable && !c.marks[id]).length;
const shownMembers = (c: Conversation): number => Object.keys(c.members).length;

/**
 * The conversation a message belongs to (right-click → View conversation). Reply-linked messages are marked; the rest were
 * linked by who answered whom. The owner confirms or removes unsure links and adds missed messages; their marks set the links
 * and are kept for training.
 */
export function ConversationView() {
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
                  {showNearby() ? 'Hide nearby messages' : 'Show nearby messages'}
                </button>
                <Show when={showNearby()}>
                  <span class="cp-hint">
                    {c().nearbyMore ? 'The nearby messages closest to this one' : 'Nearby messages'} not in the conversation: add any it missed.
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
                <For each={c().messages}>
                  {(m) => (
                    <ConversationRow
                      message={m}
                      member={c().members[m.id]}
                      mark={c().marks[m.id]}
                      root={m.id === c().rootId}
                      linked={linked().has(m.id)}
                      anchor={m.id === conversationFor()}
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
