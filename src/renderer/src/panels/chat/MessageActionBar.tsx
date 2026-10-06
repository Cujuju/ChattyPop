import { For, onCleanup, onMount } from 'solid-js';
import type { ArchiveMessage } from '@shared/contract';
import { hoverActionItems, hoverEmojiItems } from '@/plugins/slots';
import { HOST_HOVER_ACTION_ANCHORS, type HostHoverEmojiItem } from '@/plugins/messageSlots';
import { listen } from '@/ui/listen';
import { clipBounds } from '@/ui/scrollEdges';
import { SolidIcon } from '@/ui/solidIcons';
import { HoverReactions } from './HoverReactions';
import styles from './MessageActionBar.module.css';

/** The host's reaction group (hoverEmoji). */
const HOST_EMOJI: readonly HostHoverEmojiItem[] = [{ id: 'reactions', Component: HoverReactions }];

/** Message hover bar shows quick reactions, plugin actions and More, which opens the message context menu. */
export function MessageActionBar(props: { message: ArchiveMessage; onFocusWithin: (inside: boolean) => void }) {
  // Unmounted with the focus inside (the editor opened), no focusout may come: the row must not keep a stale focus.
  onCleanup(() => props.onFocusWithin(false));

  /** Opens the row’s scope-aware context menu beneath this button. */
  const more = (e: MouseEvent & { currentTarget: HTMLButtonElement }): void => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget
      .closest('[data-row-menu]')
      ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left, clientY: r.bottom }));
  };

  // Measures bars above rows, overlaying clipped top rows. Repositions focused bars on scroll/resize/visibility loss; overlaid placement persists until those events.
  let barEl!: HTMLDivElement;
  const place = (): void => {
    delete barEl.dataset.inside;
    barEl.dataset.inside = String(barEl.getBoundingClientRect().top < clipBounds(barEl).top);
  };
  onMount(() => {
    place();
    const seen = new IntersectionObserver(([e]) => e && e.intersectionRatio < 1 && place(), { threshold: 1 });
    seen.observe(barEl);
    onCleanup(() => seen.disconnect());
  });
  listen(window, 'scroll', place, { capture: true, passive: true });
  listen(window, 'resize', place);

  return (
    <div
      ref={barEl}
      class={`cp-stroke ${styles.bar}`}
      role="toolbar"
      aria-label="Message actions"
      onFocusIn={() => props.onFocusWithin(true)}
      onFocusOut={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && props.onFocusWithin(false)}
    >
      <For each={hoverEmojiItems(HOST_EMOJI)}>{(item) => <item.Component message={props.message} />}</For>
      <For each={hoverActionItems(HOST_HOVER_ACTION_ANCHORS)}>{(item) => <item.Component message={props.message} />}</For>
      <button type="button" class={styles.button} aria-label="More" title="More" aria-haspopup="menu" onClick={more}>
        <SolidIcon name="more" class={styles.icon} />
      </button>
    </div>
  );
}
