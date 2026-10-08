// The shared emoji list in an anchored picker, for choosing emoji outside a message box.
import { createUniqueId, onCleanup, onMount } from 'solid-js';
import { Portal } from 'solid-js/web';
import { loadExpressions } from '@/state/expressions';
import { coverOf, setOverlayCover } from '@/state/windows';
import { tokenPx } from '@/ui/format';
import { keepOnScreen } from '@/ui/keepOnScreen';
import { listen } from '@/ui/listen';
import type { OnPick } from './EmojiTab';
import { EmojiList } from './EmojiList';
import styles from './ReactionPicker.module.css';

/** Emoji section rail and preview, anchored to a button and kept clear of clipping panels and native Discord. */
export function EmojiPicker(props: {
  anchor: HTMLElement;
  guildId: string;
  onPick: OnPick;
  onClose: () => void;
}) {
  let root!: HTMLDivElement;
  const cover = `emoji-picker-${createUniqueId()}`;
  const place = (): void => {
    const r = props.anchor.getBoundingClientRect();
    const gap = tokenPx('--cp-space-4');
    keepOnScreen(root, r.left, r.bottom + gap, { x: r.right, y: r.top - gap });
    setOverlayCover(cover, coverOf(root));
  };
  onMount(() => {
    loadExpressions(props.guildId);
    place();
    listen(window, 'resize', place);
    listen(window, 'scroll', (e) => {
      if (!(e.target instanceof Node && root.contains(e.target))) place();
    }, true);
  });
  onCleanup(() => setOverlayCover(cover, null));
  listen(window, 'mousedown', (e) => {
    const target = e.target as Node;
    if (!root.contains(target) && !props.anchor.contains(target)) props.onClose();
  }, true);
  listen(window, 'keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    props.onClose();
  }, true);

  return (
    <Portal>
      <div ref={root} class={styles.root} role="dialog" aria-label="Emoji picker">
        <EmojiList guildId={props.guildId} onPick={props.onPick} />
      </div>
    </Portal>
  );
}
