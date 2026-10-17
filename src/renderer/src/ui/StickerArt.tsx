import { onCleanup } from '@plugin-sdk/renderer/containment';
import { Show, createSignal, onMount, type Accessor } from 'solid-js';
import type { AnimationItem } from 'lottie-web';
import { STICKER_FORMAT, type Sticker } from '@shared/compose';
import { lottieStickerUrl, stickerArtUrl, stickerStillUrl } from '@shared/media';
import { AnimatedImage } from './AnimatedImage';
import { createLazyPlayer } from './lazyPlayer';
import { createLooking } from './looking';

type StickerLike = Pick<Sticker, 'id' | 'name' | 'formatType'>;

/** Renders sticker images or Lottie animations, playing only while the owner can look. playOnHover rests on the first frame until hovered; otherwise loops. Caller class supplies size/style. */
export function StickerArt(props: { sticker: StickerLike; class?: string; playOnHover?: boolean }) {
  return (
    <Show
      when={props.sticker.formatType === STICKER_FORMAT.lottie}
      fallback={<AnimatedImage class={props.class} src={stickerArtUrl(props.sticker)} still={props.sticker.formatType === STICKER_FORMAT.png ? undefined : stickerStillUrl(props.sticker)} alt={`Sticker: ${props.sticker.name}`} title={props.sticker.name} loading="lazy" />}
    >
      <LottieSticker sticker={props.sticker} class={props.class} playOnHover={props.playOnHover ?? false} />
    </Show>
  );
}

function LottieSticker(props: { sticker: StickerLike; class?: string; playOnHover: boolean }) {
  let box!: HTMLDivElement;
  let anim: Accessor<AnimationItem | undefined> = () => undefined;
  const [failed, setFailed] = createSignal(false);

  const load = async (): Promise<AnimationItem> => {
    const res = await fetch(lottieStickerUrl(props.sticker.id));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const animationData: unknown = await res.json();
    // The light player has no expression support, so it never evaluates code from the file.
    const { default: lottie } = await import('lottie-web/build/player/lottie_light');
    // Paused on its first frame: the player decides when it plays.
    return lottie.loadAnimation({ container: box, renderer: 'svg', loop: true, autoplay: false, animationData });
  };
  const [hovered, setHovered] = createSignal(false);
  onMount(() => {
    // Loaded once first looked at; plays while looked at (and hovered, with playOnHover), stopping on the frame shown.
    const loadOrFail = (): Promise<AnimationItem | null> =>
      load().catch(() => {
        setFailed(true);
        return null;
      });
    anim = createLazyPlayer(createLooking(box), () => !props.playOnHover || hovered(), loadOrFail);
  });

  return (
    <div
      ref={box}
      class={props.class}
      role="img"
      aria-label={`Sticker: ${props.sticker.name}`}
      title={props.sticker.name}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        if (props.playOnHover) anim()?.goToAndStop(0, true);
      }}
    >
      <Show when={failed()}>{props.sticker.name}</Show>
    </div>
  );
}
