// Who-did-it tips over a message's parts (a reaction, a poll answer), after Discord's reaction tooltip: an emoji large beside
// "<what> <verb>", then one person per row and "and 3 others". Shown after the pointer rests or a touch holds; long presses
// suppress the click.
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

/** The people a tip names, and "and 1 other" / "and N others" for the rest of `count` (null: none left). */
export function tipPeople(people: PersonMatch[], count: number): { named: PersonMatch[]; others: string | null } {
  const named = people.slice(0, TIP_PEOPLE_SHOWN);
  const rest = count - named.length;
  return { named, others: rest > 0 ? `and ${rest} ${rest === 1 ? 'other' : 'others'}` : null };
}

/** A person's avatar and styled name as the channel shows it (server nickname and role colour, else display name and Nitro style). */
function TipPerson(props: { person: PersonMatch; channelId: string }) {
  return (
    <li class={styles.person}>
      <PersonFace userId={props.person.id} channelId={props.channelId} class={styles.face} />
      <span class={styles.name}>
        <AuthorName author={drawnName(props.person.id, props.channelId, props.person.name)} />
      </span>
    </li>
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
  const list = (): ReturnType<typeof tipPeople> | null => (props.people?.length ? tipPeople(props.people, props.count) : null);
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
        <div class={styles.body}>
          <p class={styles.heading}>
            <span class={styles.label}>{props.label}</span> <Show when={list()} fallback={props.status}>{props.verb}</Show>
          </p>
          <Show when={list()}>
            {(l) => (
              <ul class={styles.people}>
                <For each={l().named}>{(person) => <TipPerson person={person} channelId={props.channelId} />}</For>
                <Show when={l().others}>{(others) => <li class={styles.others}>{others()}</li>}</Show>
              </ul>
            )}
          </Show>
        </div>
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
