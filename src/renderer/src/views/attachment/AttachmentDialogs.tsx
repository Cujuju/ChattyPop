// Discord's Modify Attachment and Delete Attachment dialogs for the owner's own attachments: each shows the attachment,
// and stays open with Discord's reason when saving fails.
import { Show, createEffect, createSignal, on } from 'solid-js';
import { ALT_TEXT_MAX } from '@shared/compose';
import type { ArchiveAttachment } from '@shared/contract';
import { attachmentUrl, attachmentView } from '@shared/media';
import {
  closeDeleteAttachment,
  closeModifyAttachment,
  confirmDeleteAttachment,
  deletesMessage,
  deletingAttachment,
  modifyingAttachment,
  saveAttachment,
} from '@/state/ownAttachments';
import { look } from '@/theme/look';
import { createAction } from '@/ui/action';
import { ModalDialog } from '@/ui/ModalDialog';
import styles from './AttachmentDialogs.module.css';

/** The attachment as the dialog shows it: its picture or first frame when stored, else its name. */
function Preview(props: { attachment: ArchiveAttachment }) {
  const a = () => props.attachment;
  const src = () => (a().sha256 ? attachmentUrl(a().sha256!, a().filename) : '');
  return (
    <div class={`${styles.preview} ${look.card}`}>
      <Show when={attachmentView(a()) === 'image'}>
        <img class={styles.media} src={src()} alt={a().description ?? ''} />
      </Show>
      <Show when={attachmentView(a()) === 'video'}>
        <video class={styles.media} src={src()} preload="metadata" muted playsinline aria-label={a().filename} />
      </Show>
      <Show when={attachmentView(a()) !== 'image' && attachmentView(a()) !== 'video'}>
        <span class={look.text} data-size="sm" data-tone="secondary">
          {a().filename}
        </span>
      </Show>
    </div>
  );
}

/** The error Discord gave, under the form. */
const Failure = (props: { error: string | null }) => (
  <Show when={props.error}>
    {(text) => (
      <p class="cp-error" role="alert">
        {text()}
      </p>
    )}
  </Show>
);

/** Modify Attachment: alt text and the spoiler mark. The name shows, read-only, as in Discord. */
export function ModifyAttachmentDialog() {
  const action = createAction();
  const [description, setDescription] = createSignal('');
  const [spoiler, setSpoiler] = createSignal(false);
  createEffect(
    on(modifyingAttachment, (t) => {
      action.cancel();
      setDescription(t?.attachment.description ?? '');
      setSpoiler(t?.attachment.spoiler ?? false);
    }),
  );
  const submit = async (): Promise<void> => {
    const t = modifyingAttachment();
    if (!t || action.busy()) return;
    if (await action.run(() => saveAttachment(t, { description: description(), spoiler: spoiler() }).then(() => true))) closeModifyAttachment();
  };

  return (
    <ModalDialog id="modify-attachment" open={modifyingAttachment() !== null} title="Modify attachment" onClose={closeModifyAttachment}>
      <Show when={modifyingAttachment()}>
        {(t) => (
          <form
            class={styles.form}
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <Preview attachment={t().attachment} />
            <label class="cp-field">
              <span class="cp-label">Filename</span>
              <input type="text" value={t().attachment.filename} disabled />
            </label>
            <label class="cp-field">
              <span class="cp-label">Description (alt text)</span>
              <textarea
                class={styles.description}
                value={description()}
                placeholder="Add a description"
                maxLength={ALT_TEXT_MAX}
                disabled={action.busy()}
                onInput={(e) => setDescription(e.currentTarget.value)}
              />
            </label>
            <label class="cp-check">
              <input type="checkbox" checked={spoiler()} disabled={action.busy()} onChange={(e) => setSpoiler(e.currentTarget.checked)} />
              Mark as spoiler
            </label>
            <Failure error={action.error()} />
            <div class="cp-actions">
              <button type="button" class="cp-button" onClick={closeModifyAttachment}>
                Cancel
              </button>
              <button type="submit" class="cp-primary" disabled={action.busy()}>
                {action.busy() ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        )}
      </Show>
    </ModalDialog>
  );
}

/** Delete Attachment: asks first. A message left with nothing else is deleted whole, as Discord can't keep it empty. */
export function DeleteAttachmentDialog() {
  const action = createAction();
  createEffect(on(deletingAttachment, () => action.cancel()));
  const submit = async (): Promise<void> => {
    const t = deletingAttachment();
    if (!t || action.busy()) return;
    if (await action.run(() => confirmDeleteAttachment(t).then(() => true))) closeDeleteAttachment();
  };

  return (
    <ModalDialog id="delete-attachment" open={deletingAttachment() !== null} title="Delete attachment" onClose={closeDeleteAttachment}>
      <Show when={deletingAttachment()}>
        {(t) => (
          <form
            class={styles.form}
            method="dialog"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <p class={look.text} data-size="base" data-tone="primary">
              {deletesMessage(t())
                ? "It's all this message holds, so the message is deleted from Discord for everyone. ChattyPop keeps its archived copy."
                : "Delete this attachment? It's removed from the message on Discord for everyone; ChattyPop keeps its archived copy."}
            </p>
            <Preview attachment={t().attachment} />
            <Failure error={action.error()} />
            <div class="cp-actions">
              <button type="button" class="cp-button" onClick={closeDeleteAttachment}>
                Cancel
              </button>
              <button type="submit" class="cp-danger" disabled={action.busy()} autofocus>
                {action.busy() ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </form>
        )}
      </Show>
    </ModalDialog>
  );
}
