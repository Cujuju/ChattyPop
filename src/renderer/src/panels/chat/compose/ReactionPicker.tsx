import { Show, createSignal, onCleanup, onMount } from 'solid-js';
import { DM_GUILD_ID } from '@shared/discord';
import { channelById } from '@/state/directory';
import { loadExpressions } from '@/state/expressions';
import { asReaction, closeReactionPicker, react, reactionPicker, type ReactionPickerState } from '@/state/reactions';
import { inCompanion } from '@/state/ui';
import { coverOf, setOverlayCover } from '@/state/windows';
import { dismisses, pullDown } from '@/ui/dragDismiss';
import { tokenPx } from '@/ui/format';
import { listen, onPointerDownOutside } from '@/ui/listen';
import { EmojiList } from './EmojiList';
import type { EmojiPick } from './EmojiTab';
import styles from './ReactionPicker.module.css';

const PICKER_COVER = 'reaction-picker';

/**
 * Discord's reaction picker: one emoji list with a bar of section marks (EmojiList). On the desktop a popover where Add
 * reaction was chosen; on a phone a bottom sheet over the keyboard, closed by dragging its handle down. Shift keeps it open.
 */
export function ReactionPicker() {
  return <Show when={reactionPicker()} keyed>{(s) => <PickerAt state={s} />}</Show>;
}

function PickerAt(props: { state: ReactionPickerState }) {
  let root!: HTMLDivElement;
  const guildId = channelById(props.state.message.channelId)?.guildId ?? DM_GUILD_ID;
  const onPick = (pick: EmojiPick, keep: boolean): void => {
    react(props.state.message, asReaction(pick), true);
    if (!keep) closeReactionPicker();
  };

  // Desktop: at the point it opened, pulled inside the window. The phone's sheet is placed by its CSS.
  const place = (): void => {
    if (!inCompanion) {
      const margin = tokenPx('--cp-space-4');
      root.style.maxHeight = `${innerHeight - 2 * margin}px`;
      const r = root.getBoundingClientRect();
      root.style.left = `${Math.max(margin, Math.min(props.state.x, innerWidth - r.width - margin))}px`;
      root.style.top = `${Math.max(margin, Math.min(props.state.y, innerHeight - r.height - margin))}px`;
    }
    // The live Discord view is drawn above the page: it gets out of the picker's way.
    setOverlayCover(PICKER_COVER, coverOf(root));
  };
  onCleanup(() => setOverlayCover(PICKER_COVER, null));
  onMount(() => {
    loadExpressions(guildId);
    place();
    listen(window, 'resize', place);
  });
  onPointerDownOutside(() => root, () => true, closeReactionPicker);
  listen(window, 'keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    closeReactionPicker();
  });

  // Phone: the handle drags the sheet down; let go far enough and it closes, else it eases back.
  const [pull, setPull] = createSignal(0);
  let dragFrom: number | null = null;
  const onHandleDown = (e: PointerEvent): void => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragFrom = e.clientY;
  };
  const onHandleMove = (e: PointerEvent): void => {
    if (dragFrom !== null) setPull(pullDown(e.clientY - dragFrom));
  };
  const onHandleUp = (e: PointerEvent): void => {
    if (dragFrom === null) return;
    dragFrom = null;
    const pulled = pull();
    setPull(0);
    if (dismisses(pulled, e.type === 'pointerup')) closeReactionPicker();
  };

  return (
    <div
      ref={root}
      class={styles.root}
      role="dialog"
      aria-label="Add reaction"
      data-dragging={pull() > 0}
      style={pull() ? { translate: `0 ${pull()}px` } : undefined}
    >
      <Show when={inCompanion}>
        <div class={styles.handle} aria-hidden="true" onPointerDown={onHandleDown} onPointerMove={onHandleMove} onPointerUp={onHandleUp} onPointerCancel={onHandleUp} />
      </Show>
      <EmojiList guildId={guildId} onPick={onPick} />
    </div>
  );
}
