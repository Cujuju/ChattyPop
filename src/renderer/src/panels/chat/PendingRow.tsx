// A message on its way, at the log's end as Discord shows one: dimmed while sending, its pictures with an upload ring,
// and "Failed to send" under it when it didn't go.
import { For, Show, onCleanup } from 'solid-js';
import type { ArchiveMessage } from '@shared/contract';
import { mediaKind } from '@shared/media';
import { BYTES_PER_KB } from '@shared/units';
import { discardSend, editSend, retrySend, type Outgoing } from '@/state/outbox';
import { draftFiles, draftText } from '@/state/composer';
import { Markdown } from '@/ui/Markdown';
import { AuthorName } from './AuthorName';
import { Avatar } from './MessageRow';
import cozy from './Cozy.module.css';
import rowStyles from './MessageRow.module.css';
import styles from './PendingRow.module.css';

const PHASE_TEXT: Record<NonNullable<Outgoing['phase']>, string> = { preparing: 'Preparing…', uploading: 'Uploading…', posting: 'Sending…' };

export interface PendingRowProps {
  outgoing: Outgoing;
  channelId: string;
  /** The owner's latest message here, for their name and avatar; null shows the row without a header. */
  own: ArchiveMessage | null;
  /** Continues the owner's group above (no avatar or name). */
  grouped: boolean;
}

export function PendingRow(props: PendingRowProps) {
  const o = () => props.outgoing;
  const failed = () => o().status === 'failed';
  const headed = () => !props.grouped && props.own !== null;
  return (
    <article class={`${rowStyles.row} ${cozy.row} ${styles.row}`} data-density="cozy" data-grouped={!headed()} data-failed={failed()} aria-busy={!failed()}>
      <Show when={headed() && props.own} fallback={<span class={cozy.gutterTime} />}>
        {(own) => <Avatar message={own()} />}
      </Show>
      <div class={cozy.main}>
        <Show when={headed() && props.own}>
          {(own) => (
            <div class={cozy.head}>
              <AuthorName author={own().author} class={cozy.name} />
              <span class={styles.state}>{failed() ? '' : PHASE_TEXT[o().phase ?? 'posting']}</span>
            </div>
          )}
        </Show>
        <Show when={o().text}>
          <div class={styles.text}>
            <Markdown text={o().text} mentions={o().mentions} />
          </div>
        </Show>
        <Show when={o().files.length}>
          <div class={styles.files}>
            <For each={o().files}>{(f) => <PendingFile file={f} outgoing={o()} />}</For>
          </div>
        </Show>
        <Show when={failed()}>
          <div class={styles.failure}>
            <button type="button" class={styles.retry} disabled={!o().retryable} onClick={() => retrySend(props.channelId, o().id)}>
              {o().retryable ? 'Failed to send. Tap to retry.' : 'Failed to send.'}
            </button>
            <Show when={o().error}>{(e) => <span class={styles.reason}>{e()}</span>}</Show>
            <span class={styles.actions}>
              <Show when={o().editable}>
                <button
                  type="button"
                  class="cp-button"
                  disabled={!!draftText(props.channelId) || draftFiles(props.channelId).length > 0}
                  title="Put it back in the message box to change it (the box must be empty)"
                  onClick={() => editSend(props.channelId, o().id)}
                >
                  Edit
                </button>
              </Show>
              <button type="button" class="cp-button" onClick={() => discardSend(props.channelId, o().id)}>
                Discard
              </button>
            </span>
          </div>
        </Show>
      </div>
    </article>
  );
}

/** A picture or video as picked, with the upload ring while it goes; another file as a chip. */
function PendingFile(props: { file: File; outgoing: Outgoing }) {
  const kind = mediaKind({ contentType: props.file.type, filename: props.file.name });
  const url = kind === 'image' || kind === 'video' ? URL.createObjectURL(props.file) : null;
  onCleanup(() => url && URL.revokeObjectURL(url));
  const busy = () => props.outgoing.phase === 'preparing' || props.outgoing.phase === 'uploading';
  return (
    <div class={styles.file}>
      <Show
        when={url}
        fallback={
          <span class={styles.chip}>
            {props.file.name} · {Math.round(props.file.size / BYTES_PER_KB)} KB
          </span>
        }
      >
        {(src) => (kind === 'video' ? <video class={styles.media} src={src()} muted playsinline preload="metadata" /> : <img class={styles.media} src={src()} alt={props.file.name} />)}
      </Show>
      <Show when={busy()}>
        <svg class={styles.ring} viewBox="0 0 36 36" role="progressbar" aria-valuemin={0} aria-valuemax={1} aria-valuenow={props.outgoing.progress ?? undefined}>
          <circle class={styles.track} cx="18" cy="18" r="15" pathLength="1" />
          <circle class={styles.arc} cx="18" cy="18" r="15" pathLength="1" style={{ '--progress': String(props.outgoing.progress ?? 0) }} />
        </svg>
      </Show>
    </div>
  );
}
