// A custom emoji in message text, after Discord's: resting the pointer on it names it, a click opens its popout (where it's
// from, and whether the owner can use it). Pointer only: on touch it stays text, so a double tap still reacts (ui/touch.ts).
import { onCleanup } from '@plugin-sdk/renderer/containment';
import { Show, createContext, createResource, createSignal, onMount, useContext } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { CustomEmoji } from '@shared/emoji';
import { directory } from '@/state/directory';
import { emojiSource } from '@/state/emojiSources';
import { expressionCatalog, loaded } from '@/state/expressions';
import { EmojiImage } from '@/ui/AnimatedImage';
import { errorText, tokenPx } from '@/ui/format';
import { GuildIcon } from '@/ui/GuildIcon';
import { keepOnScreen } from '@/ui/keepOnScreen';
import { listen } from '@/ui/listen';
import { emojiBlurb, emojiOrigin, serverKind } from './emojiBlurb';
import { EmojiNameTip, HOVER_DELAY_MS } from './HoverTip';
import styles from './MessageEmoji.module.css';

/** The server of the channel the text is in (undefined: a DM, or text outside a channel), for "this server". */
export const EmojiChannelGuild = createContext<() => string | undefined>(() => undefined);

/** A press on an emoji inside a spoiler still covered reveals the spoiler, as in Discord, and nothing more. */
const covered = (el: Element): boolean => el.closest('[data-shown="false"]') !== null;

export function MessageEmoji(props: { emoji: CustomEmoji; class: string; jumbo: boolean }) {
  let img!: HTMLImageElement;
  let timer = 0;
  const guildId = useContext(EmojiChannelGuild);
  const [tip, setTip] = createSignal(false);
  const [open, setOpen] = createSignal(false);
  const hideTip = (): void => {
    clearTimeout(timer);
    setTip(false);
  };
  onCleanup(() => clearTimeout(timer));
  return (
    <>
      <EmojiImage
        ref={(el) => (img = el)}
        class={props.class}
        data-text-emoji
        data-jumbo={props.jumbo}
        data-opens
        emoji={props.emoji}
        alt={`:${props.emoji.name}:`}
        loading="lazy"
        onPointerEnter={(e) => {
          if (e.pointerType === 'touch' || open() || covered(img)) return;
          clearTimeout(timer);
          timer = window.setTimeout(() => setTip(true), HOVER_DELAY_MS);
        }}
        onPointerLeave={hideTip}
        onClick={(e) => {
          if ((e instanceof PointerEvent && e.pointerType === 'touch') || covered(img)) return;
          hideTip();
          setOpen((was) => !was);
        }}
      />
      <Show when={tip()}>
        <EmojiNameTip anchor={img} emoji={props.emoji} hint="Click to learn more" />
      </Show>
      <Show when={open()}>
        <EmojiPopout anchor={img} emoji={props.emoji} guildId={guildId()} onClose={() => setOpen(false)} />
      </Show>
    </>
  );
}

/** Beside the emoji (left of it when the right has no room), closed by a press elsewhere, Escape, or the page scrolling. */
function EmojiPopout(props: { anchor: HTMLElement; emoji: CustomEmoji; guildId: string | undefined; onClose: () => void }) {
  let root!: HTMLDivElement;
  const [source] = createResource(() => props.emoji.id, emojiSource);
  const everywhere = (): boolean => loaded(expressionCatalog)?.perks.emojiEverywhere ?? false;
  const blurb = (): string => {
    if (source.error) return `Couldn't look up this emoji: ${errorText(source.error)}`;
    const s = source.latest;
    return s ? emojiBlurb(emojiOrigin(s, props.guildId), everywhere()) : 'Looking up this emoji…';
  };
  /** The server's card. One of the owner's own shows only while ChattyPop shows that server (privacy can hide it). */
  const guild = () => {
    const s = source.latest;
    if (!s?.guild) return undefined;
    if (!s.joined) return { ...s.guild, kind: serverKind(s.guild) };
    const shown = directory().find((g) => g.id === s.guild!.id);
    return shown && { id: shown.id, name: shown.name, icon: shown.icon, kind: serverKind(s.guild) };
  };
  const place = (): void => {
    const r = props.anchor.getBoundingClientRect();
    const gap = tokenPx('--cp-space-4');
    keepOnScreen(root, r.right + gap, r.top, { x: r.left - gap, y: r.bottom });
  };
  onMount(() => {
    place();
    root.focus({ preventScroll: true });
    // It grows once its server is known: placed again, so it stays inside the window.
    const grown = new ResizeObserver(place);
    grown.observe(root);
    onCleanup(() => grown.disconnect());
  });
  listen(window, 'resize', place);
  listen(window, 'mousedown', (e) => {
    const t = e.target as Node;
    if (!root.contains(t) && !props.anchor.contains(t)) props.onClose();
  }, true);
  listen(window, 'scroll', (e) => !(e.target instanceof Node && root.contains(e.target)) && props.onClose(), true);
  listen(window, 'keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    props.onClose();
  });
  return (
    <Portal>
      <div ref={root} class={`cp-popover ${styles.popout}`} role="dialog" aria-label={`:${props.emoji.name}:`} tabIndex={-1}>
        <div class={styles.head}>
          <EmojiImage class={styles.emoji} emoji={props.emoji} alt="" />
          <div class={styles.about}>
            <strong class={styles.name}>:{props.emoji.name}:</strong>
            <p class={styles.blurb} data-error={!!source.error}>{blurb()}</p>
          </div>
        </div>
        <Show when={guild()}>
          {(g) => (
            <div class={styles.from}>
              <p class={styles.fromLabel}>This emoji is from</p>
              <div class={styles.guild}>
                <GuildIcon id={g().id} name={g().name} icon={g().icon} />
                <div class={styles.guildText}>
                  <strong class={styles.guildName} title={g().name}>{g().name}</strong>
                  <span class={styles.guildKind}>{g().kind}</span>
                </div>
              </div>
            </div>
          )}
        </Show>
      </div>
    </Portal>
  );
}
