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

/**
 * The bar Discord shows at a hovered message's top-right: its reaction group (hoverEmoji), plugins' actions (hoverActions:
 * a posting plugin's Edit, Reply, Forward) and More (the message's right-click menu, opened under the button).
 */
export function MessageActionBar(props: { message: ArchiveMessage; onFocusWithin: (inside: boolean) => void }) {
  // Unmounted with the focus inside (the editor opened), no focusout may come: the row must not keep a stale focus.
  onCleanup(() => props.onFocusWithin(false));

  /** The row's own menu, as a right-click on it would open it (its handler knows the row's scope), under this button. */
  const more = (e: MouseEvent & { currentTarget: HTMLButtonElement }): void => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget
      .closest('[data-row-menu]')
      ?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left, clientY: r.bottom }));
  };

  // Above the row, clear of its text; on the topmost row, where the log's edge would cut it off, over the row's top.
  // Measured above, then placed. A focused bar stays while its row moves: placed again on scroll, resize, or whenever it
  // stops showing in full (rows arriving below). Residual: a bar placed over its row stays there until one of those.
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
