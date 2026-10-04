// Discord's Delete Message dialog: asks, with the message as the log draws it (author, time, text, files), and stays
// open with Discord's reason when the delete fails.
import { For, Show, createEffect, on } from 'solid-js';
import { avatarUrl } from '@shared/media';
import { AuthorName } from '@/panels/chat/AuthorName';
import { closeDeleteDialog, confirmDelete, deletingMessage } from '@/state/ownMessages';
import { today } from '@/state/clock';
import { look } from '@/theme/look';
import { createAction } from '@/ui/action';
import { messageTime } from '@/ui/format';
import { Markdown } from '@/ui/Markdown';
import { ModalDialog } from '@/ui/ModalDialog';
import styles from './DeleteMessageDialog.module.css';

export function DeleteMessageDialog() {
  const action = createAction();
  createEffect(on(deletingMessage, () => action.cancel()));
  const submit = async (): Promise<void> => {
    const m = deletingMessage();
    if (!m || action.busy()) return;
    if (await action.run(() => confirmDelete(m).then(() => true))) closeDeleteDialog();
  };

  return (
    <ModalDialog id="delete-message" open={deletingMessage() !== null} title="Delete message" onClose={closeDeleteDialog}>
      <p class={look.text} data-size="base" data-tone="primary">
        Delete this message? It's removed from Discord for everyone; ChattyPop keeps its archived copy.
      </p>
      <Show when={deletingMessage()}>
        {(m) => (
          <article class={`${styles.preview} ${look.card}`} aria-label="The message">
            <img class={`${styles.avatar} ${look.avatar}`} src={avatarUrl(m().author.id, m().author.avatar)} alt="" />
            <div class={styles.head}>
              <AuthorName author={m().author} />
              <time class={look.text} data-size="xs" data-tone="muted" dateTime={new Date(m().ts).toISOString()}>
                {messageTime(m().ts, today())}
              </time>
            </div>
            <div class={`${styles.text} ${look.text}`} data-size="base" data-line="relaxed" data-tone="primary">
              <Show when={m().content}>
                <Markdown text={m().content} mentions={m().mentions} />
              </Show>
              <Show when={m().attachments.length || m().stickers.length}>
                <ul class={styles.files}>
                  <For each={[...m().attachments.map((a) => a.filename), ...m().stickers.map((s) => `Sticker: ${s.name}`)]}>
                    {(name) => (
                      <li class={look.text} data-size="sm" data-tone="muted">
                        {name}
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <Show when={!m().content && !m().attachments.length && !m().stickers.length}>
                <span class={look.text} data-tone="muted">
                  No text.
                </span>
              </Show>
            </div>
          </article>
        )}
      </Show>
      <Show when={action.error()}>
        {(text) => (
          <p class="cp-error" role="alert">
            {text()}
          </p>
        )}
      </Show>
      <form
        class="cp-actions"
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <button type="button" class="cp-button" onClick={closeDeleteDialog}>
          Cancel
        </button>
        <button type="submit" class="cp-danger" disabled={action.busy()} autofocus>
          {action.busy() ? 'Deleting…' : 'Delete'}
        </button>
      </form>
    </ModalDialog>
  );
}
