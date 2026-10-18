// Reaction tooltips show emoji and reactors (avatar, name in the place) after pointer rests or touch holds. Long presses suppress reaction toggles.
import { onCleanup } from '@plugin-sdk/renderer/containment';
import { For, Show, createMemo, createSignal, onMount, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { ArchiveMessage, ArchiveReaction, PersonMatch } from '@shared/contract';
import { EmojiImage } from '@/ui/AnimatedImage';
import { api } from '@/api';
import { cachedThenLive } from '@/state/cachedLive';
import { onPointerDownOutside } from '@/ui/listen';
import { AuthorName } from './AuthorName';
import { PersonFace, drawnName } from './PersonName';
import styles from './ReactionTip.module.css';

/** Pointer dwell delay before showing/fetching reaction tips. */
const HOVER_DELAY_MS = 300;
/** Viewport clearance for overflowing reaction tips. */
const EDGE_GAP_PX = 8;

/** The people Discord listed, then "1 other" / "N others" for the rest of `count`. */
export function reactorItems(people: PersonMatch[], count: number): (PersonMatch | string)[] {
  const others = count - people.length;
  return others > 0 ? [...people, others === 1 ? '1 other' : `${others} others`] : people;
}

/** What precedes item `i` of `n`: "A", "A and B", "A, B and C". */
export function listSeparator(i: number, n: number): string {
  if (i === 0) return '';
  return i === n - 1 ? ' and ' : ', ';
}

/** A reactor's avatar and styled name as the channel shows it (server nickname and role colour, else display name and Nitro style). */
function Reactor(props: { person: PersonMatch; channelId: string }) {
  return (
    <span class={styles.reactor}>
      <PersonFace userId={props.person.id} channelId={props.channelId} class={styles.face} />
      <AuthorName author={drawnName(props.person.id, props.channelId, props.person.name)} />
    </span>
  );
}

function Tip(props: { message: ArchiveMessage; reaction: ArchiveReaction; anchor: HTMLElement }) {
  const r = () => props.reaction;
  // A plain emoji: the message's is a store proxy, which IPC can't clone.
  const key = createMemo(() => {
    const { id, name, animated } = r().emoji;
    return { channelId: props.message.channelId, messageId: props.message.id, emoji: { id, name, animated }, count: r().count };
  });
  const reactors = cachedThenLive(
    key,
    (k) => api.core.reactors(k.messageId, k.emoji.id ?? k.emoji.name),
    (k) => api.discord.reactors(k.channelId, k.messageId, k.emoji, k.count),
    // A cached list whose count still matches is current: reacting changes the count.
    (copy, k) => !copy || copy.count !== k.count,
  );
  const items = (): (PersonMatch | string)[] | null => {
    const v = reactors.value();
    return v?.people.length ? reactorItems(v.people, r().count) : null;
  };
  const status = (): string => (reactors.stale() ? `${r().count} reacted · Discord couldn't be reached` : 'Loading…');
  let tip!: HTMLDivElement;
  const [left, setLeft] = createSignal(0);
  const rect = props.anchor.getBoundingClientRect();
  onMount(() => {
    const half = tip.offsetWidth / 2;
    setLeft(Math.min(Math.max(rect.left + rect.width / 2, half + EDGE_GAP_PX), window.innerWidth - half - EDGE_GAP_PX));
  });
  return (
    <Portal>
      <div ref={tip} class={styles.tip} role="tooltip" style={{ left: `${left()}px`, top: `${rect.top}px` }}>
        <Show when={r().emoji.id} fallback={<span class={styles.unicode}>{r().emoji.name}</span>}>
          {(id) => <EmojiImage class={styles.emoji} emoji={{ id: id(), animated: r().emoji.animated }} alt="" />}
        </Show>
        <p class={styles.text}>
          <span class={styles.name}>:{r().emoji.name}:</span>{' '}
          <Show when={items()} fallback={status()}>
            {(list) => (
              <>
                reacted by{' '}
                <For each={list()}>
                  {(item, i) => (
                    <>
                      {listSeparator(i(), list().length)}
                      {typeof item === 'string' ? item : <Reactor person={item} channelId={props.message.channelId} />}
                    </>
                  )}
                </For>
              </>
            )}
          </Show>
        </p>
      </div>
    </Portal>
  );
}

/** Wraps pills with pointer-rest/touch-hold tooltips. consumeHold returns true once to suppress the post-hold click toggle. */
export function ReactionTipAnchor(props: {
  message: ArchiveMessage;
  reaction: ArchiveReaction;
  class?: string;
  children: (consumeHold: () => boolean) => JSX.Element;
}) {
  let el!: HTMLSpanElement;
  let timer = 0;
  let touch = false;
  let held = false;
  const [shown, setShown] = createSignal(false);
  const hide = (): void => {
    clearTimeout(timer);
    held = false;
    setShown(false);
  };
  onCleanup(() => clearTimeout(timer));
  onPointerDownOutside(() => el, shown, hide);
  const consumeHold = (): boolean => {
    const was = held;
    held = false;
    return was;
  };
  return (
    <span
      ref={el}
      class={props.class}
      onPointerEnter={(e) => {
        if (e.pointerType === 'touch') return;
        clearTimeout(timer);
        timer = window.setTimeout(() => setShown(true), HOVER_DELAY_MS);
      }}
      // A long-pressed tip stays until a press elsewhere: touch screens also send mouse-style leave events.
      onPointerLeave={(e) => e.pointerType !== 'touch' && !held && hide()}
      onPointerDown={(e) => {
        touch = e.pointerType === 'touch';
        held = false;
        if (!touch) hide();
      }}
      // A touch's long press shows this tip instead of the message's menu; a right-click still opens the menu.
      onContextMenu={(e) => {
        if (!touch) return;
        e.preventDefault();
        e.stopPropagation();
        held = true;
        setShown(true);
      }}
    >
      {props.children(consumeHold)}
      <Show when={shown()}>
        <Tip message={props.message} reaction={props.reaction} anchor={el} />
      </Show>
    </span>
  );
}