// Who-did-it tips over a message's parts (a reaction, a poll answer), as Discord's reaction tooltip: an emoji large beside
// "<what> <verb> A, B and 3 others", shown after the pointer rests or a touch holds. Long presses suppress the click.
import { onCleanup } from '@plugin-sdk/renderer/containment';
import { For, Show, createSignal, onMount, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { ArchiveEmoji, PersonMatch } from '@shared/contract';
import { EmojiImage } from '@/ui/AnimatedImage';
import { onPointerDownOutside } from '@/ui/listen';
import { AuthorName } from './AuthorName';
import { PersonFace, drawnName } from './PersonName';
import styles from './HoverTip.module.css';

/** Pointer dwell delay before showing (and fetching) a tip. */
const HOVER_DELAY_MS = 300;
/** Viewport clearance for a tip that would overflow. */
const EDGE_GAP_PX = 8;
/** People a tip names before "N others", as Discord's reaction tooltip. */
export const TIP_PEOPLE_SHOWN = 3;

/** The first people listed, then "1 other" / "N others" for the rest of `count`. */
export function peopleItems(people: PersonMatch[], count: number): (PersonMatch | string)[] {
  const named = people.slice(0, TIP_PEOPLE_SHOWN);
  const others = count - named.length;
  return others > 0 ? [...named, others === 1 ? '1 other' : `${others} others`] : named;
}

/** What precedes item `i` of `n`: "A", "A and B", "A, B and C". */
export function listSeparator(i: number, n: number): string {
  if (i === 0) return '';
  return i === n - 1 ? ' and ' : ', ';
}

/** A person's avatar and styled name as the channel shows it (server nickname and role colour, else display name and Nitro style). */
function TipPerson(props: { person: PersonMatch; channelId: string }) {
  return (
    <span class={styles.person}>
      <PersonFace userId={props.person.id} channelId={props.channelId} class={styles.face} />
      <AuthorName author={drawnName(props.person.id, props.channelId, props.person.name)} />
    </span>
  );
}

/**
 * The tip over `anchor`: `emoji` large (none: text only), then `label` and `verb` before the people, or `status` until
 * they're known. `count`: how many did it, so the rest read as "N others".
 */
export function PeopleTip(props: {
  anchor: HTMLElement;
  emoji: ArchiveEmoji | null;
  label: string;
  verb: string;
  people: PersonMatch[] | null;
  count: number;
  channelId: string;
  status: string;
}) {
  let tip!: HTMLDivElement;
  const [left, setLeft] = createSignal(0);
  const rect = props.anchor.getBoundingClientRect();
  onMount(() => {
    const half = tip.offsetWidth / 2;
    setLeft(Math.min(Math.max(rect.left + rect.width / 2, half + EDGE_GAP_PX), window.innerWidth - half - EDGE_GAP_PX));
  });
  const items = (): (PersonMatch | string)[] | null => (props.people?.length ? peopleItems(props.people, props.count) : null);
  return (
    <Portal>
      <div ref={tip} class={styles.tip} role="tooltip" style={{ left: `${left()}px`, top: `${rect.top}px` }}>
        <Show when={props.emoji}>
          {(e) => (
            <Show when={e().id} fallback={<span class={styles.unicode}>{e().name}</span>}>
              {(id) => <EmojiImage class={styles.emoji} emoji={{ id: id(), animated: e().animated }} alt="" />}
            </Show>
          )}
        </Show>
        <p class={styles.text}>
          <span class={styles.label}>{props.label}</span>{' '}
          <Show when={items()} fallback={props.status}>
            {(list) => (
              <>
                {props.verb}{' '}
                <For each={list()}>
                  {(item, i) => (
                    <>
                      {listSeparator(i(), list().length)}
                      {typeof item === 'string' ? item : <TipPerson person={item} channelId={props.channelId} />}
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

/** Wraps an element with a pointer-rest/touch-hold tip. consumeHold returns true once to suppress the post-hold click. */
export function HoverTipAnchor(props: {
  class?: string;
  /** Its role where it stands in for the element it wraps (a list's item). */
  role?: JSX.HTMLAttributes<HTMLSpanElement>['role'];
  tip: (anchor: HTMLElement) => JSX.Element;
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
      role={props.role}
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
      <Show when={shown()}>{props.tip(el)}</Show>
    </span>
  );
}
