import { Show, createEffect, createMemo, createSignal, on, useContext, type JSX } from 'solid-js';
import { isLocalSpoiler } from '@/state/localSpoilers';
import { SpoilersShown } from './spoilers';
import styles from './LocalSpoiler.module.css';

export const localSpoilerTitle = (senderSpoiler: boolean): string => senderSpoiler
  ? 'Marked as a spoiler by you in ChattyPop; the sender also marked it as a spoiler.'
  : 'Marked as a spoiler by you in ChattyPop; the sender did not mark it as a spoiler.';

/** Persistent provenance, also visible after revealing the content. */
export function LocalSpoilerBadge(props: { senderSpoiler: boolean; inline?: boolean }) {
  return <span class={styles.badge} data-inline={props.inline} data-spoiler-control title={localSpoilerTitle(props.senderSpoiler)}>Local spoiler</span>;
}

/** A local cover always requires a deliberate reveal, regardless of Discord's show-spoilers preference. */
export function createSpoilerCover(key: () => string | null, senderSpoiler: () => boolean) {
  const uncovered = useContext(SpoilersShown);
  const local = createMemo(() => isLocalSpoiler(key()));
  const [revealed, reveal] = createSignal(false);
  createEffect(on([key, local, senderSpoiler], () => reveal(false)));
  return { local, covered: () => !revealed() && (local() || (senderSpoiler() && !uncovered())), reveal: () => reveal(true) };
}

/** Link text and preview cards retain their size while covered, with their controls and media inert. */
export function LocalSpoiler(props: { spoilerKey: string | null; senderSpoiler?: boolean; inline?: boolean; label: string; children: JSX.Element }) {
  // Inline sender spoilers already have Markdown's cover; preserve its single-click reveal.
  const cover = createSpoilerCover(() => props.spoilerKey, () => !props.inline && (props.senderSpoiler ?? false));
  let content!: HTMLSpanElement;
  createEffect(() => {
    if (cover.covered()) content.querySelectorAll<HTMLMediaElement>('audio, video').forEach((player) => player.pause());
  });
  return (
    <span class={styles.root} data-inline={props.inline} data-covered={cover.covered()} data-local-spoiler-key={props.spoilerKey ?? undefined} data-sender-spoiler={props.senderSpoiler ?? false}>
      <span ref={content} class={styles.content} inert={cover.covered()} aria-hidden={cover.covered() || undefined}>{props.children}</span>
      <Show when={cover.covered()}>
        <button class={styles.cover} type="button" aria-label={`${cover.local() ? 'Local spoiler' : 'Spoiler'}: show ${props.label}`} title={cover.local() ? localSpoilerTitle(props.senderSpoiler ?? false) : undefined} onClick={cover.reveal}>
          {cover.local() ? 'Local spoiler' : 'Spoiler'}
        </button>
      </Show>
      <Show when={cover.local() && (!props.inline || !cover.covered())}><LocalSpoilerBadge senderSpoiler={props.senderSpoiler ?? false} inline={props.inline} /></Show>
    </span>
  );
}
