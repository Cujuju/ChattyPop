import { For, Show } from 'solid-js';
import { openArchive } from '@/state/archive';
import { closeConversation, conversation, conversationFor } from '@/state/conversation';
import { openPerson } from '@/state/person';
import { clockTime, countText, shortDate } from '@/ui/format';
import { FloatingWindow, WindowHeader } from '@/ui/FloatingWindow';
import { Markdown } from '@/ui/Markdown';
import chrome from '@/ui/WindowChrome.module.css';
import styles from './ConversationView.module.css';

/** The exchange a message belongs to (right-click → View conversation). Reply-linked messages are marked; the rest were grouped by time. */
export function ConversationView() {
  const linked = (): Set<string> => new Set(conversation()?.linkedIds ?? []);
  return (
    <FloatingWindow id="conversation" open={conversationFor() !== null} class={chrome.dialog} aria-label="Conversation" onClose={closeConversation}>
      <WindowHeader title="Conversation" classes={chrome} closeLabel="Close" onClose={closeConversation} />
      <div class={chrome.body}>
        <Show when={conversation.error}>
          <p class="cp-error" role="alert">
            Couldn't load this conversation.
          </p>
        </Show>
        <Show when={conversation()}>
          {(c) => (
            <Show when={c().messages.length} fallback={<p class="cp-hint">This message isn't in the archive.</p>}>
              <p class="cp-hint">
                {shortDate(c().messages[0]!.ts)} · {countText(c().messages.length, 'message')} ·{' '}
                {/* linkedIds always holds the message itself; more than one means Discord replies joined others. */}
                {c().linkedIds.length > 1 ? `${c().linkedIds.length} joined by replies (marked)` : 'no replies'}; the rest grouped by who took part and short gaps.
              </p>
              <ol class={styles.list}>
                <For each={c().messages}>
                  {(m) => (
                    <li class={styles.row} data-linked={linked().has(m.id)} data-anchor={m.id === conversationFor()}>
                      <button type="button" class={styles.time} title="Open in the Archive" onClick={() => void openArchive(m.channelId, m.id)}>
                        {clockTime(m.ts)}
                      </button>
                      <button type="button" class={styles.author} onClick={() => openPerson(m.author.id)}>
                        {m.author.name}
                      </button>
                      <div class={styles.text}>
                        <Show when={m.deletedAt}>
                          <span class={styles.note}>deleted · </span>
                        </Show>
                        <Markdown text={m.content} mentions={m.mentions} />
                        <Show when={m.attachments.length}>
                          <span class={styles.note}> [{countText(m.attachments.length, 'attachment')}]</span>
                        </Show>
                      </div>
                    </li>
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
