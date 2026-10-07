// The hover bar's reaction group, the host's hoverEmoji item: the owner's most-used reactions, Add reaction and the
// divider before the actions.
import { Index, Show, createEffect, onCleanup, onMount } from 'solid-js';
import type { ArchiveEmoji, ArchiveMessage } from '@shared/contract';
import { EmojiImage } from '@/ui/AnimatedImage';
import { prepareQuickReactions, quickReactions } from '@/state/quickReactions';
import { canReact, openReactionPicker, react, reactedWith } from '@/state/reactions';
import { SolidIcon } from '@/ui/solidIcons';
import styles from './MessageActionBar.module.css';

/** One-tap reactions on the bar, as asked for: the owner's five most used. */
const BAR_REACTIONS = 5;

const emojiLabel = (e: ArchiveEmoji): string => (e.id ? `:${e.name}:` : e.name);

/** Quick reaction squares and Add reaction, for a message the owner may react to. */
export function HoverReactions(props: { message: ArchiveMessage }) {
  const m = () => props.message;
  onMount(() => prepareQuickReactions(props.message));

  // Squares clipped away (a narrow panel: wrapped onto the hidden line, or cut at the side) are out of reach of Tab and
  // screen readers too.
  let reactionsEl!: HTMLDivElement;
  const markClipped = (): void => {
    const box = reactionsEl.getBoundingClientRect();
    for (const b of reactionsEl.children as HTMLCollectionOf<HTMLElement>) {
      const r = b.getBoundingClientRect();
      b.inert = r.top < box.top || r.bottom > box.bottom || r.left < box.left || r.right > box.right;
    }
  };
  onMount(() => {
    const observer = new ResizeObserver(markClipped);
    observer.observe(reactionsEl);
    onCleanup(() => observer.disconnect());
  });
  createEffect(() => {
    emojis();
    queueMicrotask(markClipped);
  });
  const emojis = (): ArchiveEmoji[] => (canReact(m()) ? quickReactions(m(), BAR_REACTIONS) : []);

  /** The full emoji picker, opened under this button. */
  const addReaction = (e: MouseEvent & { currentTarget: HTMLButtonElement }): void => {
    const r = e.currentTarget.getBoundingClientRect();
    openReactionPicker(m(), r.left, r.bottom);
  };

  return (
    <>
      <div class={styles.reactions} ref={reactionsEl}>
        {/* By position, not identity: a refreshed ranking re-labels the squares in place, keeping the focused one. */}
        <Index each={emojis()}>
          {(e) => (
            <button
              type="button"
              class={styles.button}
              aria-pressed={reactedWith(m(), e())}
              aria-label={`React with ${emojiLabel(e())}`}
              title={emojiLabel(e())}
              onClick={() => react(m(), e(), !reactedWith(m(), e()))}
            >
              <Show when={e().id} fallback={<span class={styles.glyph}>{e().name}</span>}>
                {(id) => <EmojiImage class={styles.image} emoji={{ id: id(), animated: e().animated }} alt="" />}
              </Show>
            </button>
          )}
        </Index>
      </div>
      <Show when={canReact(m())}>
        <button type="button" class={styles.button} aria-label="Add reaction" title="Add reaction" aria-haspopup="dialog" onClick={addReaction}>
          <SolidIcon name="addReaction" class={styles.icon} />
        </button>
        <span class={styles.divider} aria-hidden="true" />
      </Show>
    </>
  );
}
