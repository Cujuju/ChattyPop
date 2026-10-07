// Animated pictures (GIF, APNG, animated WebP) drawn frame by frame, so they stop on the frame shown while the owner
// can't look (looking.ts) and go on from it. An <img> can't pause, and a canvas copy of one is its first frame.
import { Show, createEffect, createSignal, on, onCleanup, splitProps, type JSX } from 'solid-js';
import { emojiUrl, type CustomEmoji } from '@shared/emoji';
import { mayAnimate } from '@shared/media';
import { createLooking, createOnScreen } from './looking';


/** A frame this short or unset (GIFs made for old players) shows for SHORT_FRAME_SHOWN_US instead, as an <img> does. */
const SHORT_FRAME_US = 10_000;
const SHORT_FRAME_SHOWN_US = 100_000;
const US_PER_MS = 1000;

/** What the <img> and its canvas both carry. */
interface Shared {
  class?: string;
  style?: JSX.CSSProperties;
  title?: string;
  [data: `data-${string}`]: string | boolean | undefined;
}

export interface AnimatedImageProps extends Shared {
  src: string;
  alt: string;
  /** Known not to move (an emoji that isn't animated): a plain <img>, never decoded. */
  still?: boolean;
  loading?: 'lazy' | 'eager';
  draggable?: boolean;
  /** The element shown: the <img>, then its canvas once it plays frame by frame. */
  ref?: (el: HTMLImageElement | HTMLCanvasElement) => void;
}


interface Player {
  decoder: ImageDecoder;
  first: ImageBitmap;
  firstUs: number;
  frames: number;
  /** Plays after the first; Infinity loops forever. */
  repetitions: number;
}

const shownUs = (durationUs: number | null): number => (durationUs === null || durationUs <= SHORT_FRAME_US ? SHORT_FRAME_SHOWN_US : durationUs);

const closePlayer = (p: Player | null): void => {
  p?.decoder.close();
  p?.first.close();
};

/** `src` as an animation, or null when it is a still, unsupported here, or unreadable (it stays an <img>). */
async function openPlayer(src: string): Promise<Player | null> {
  if (typeof ImageDecoder === 'undefined') return null; // a browser without WebCodecs (older Safari)
  const res = await fetch(src);
  const type = res.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
  if (!res.ok || !mayAnimate(type) || !(await ImageDecoder.isTypeSupported(type))) {
    void res.body?.cancel();
    return null;
  }
  const decoder = new ImageDecoder({ data: await res.arrayBuffer(), type });
  await decoder.tracks.ready;
  const track = decoder.tracks.selectedTrack;
  if (!track?.animated || track.frameCount < 2) {
    decoder.close();
    return null;
  }
  const { image } = await decoder.decode({ frameIndex: 0 });
  const first = await createImageBitmap(image);
  const firstUs = shownUs(image.duration);
  image.close();
  return { decoder, first, firstUs, frames: track.frameCount, repetitions: track.repetitionCount };
}

/** An <img> whose animation plays only while the owner can look at it. Opened once on screen; a still stays an <img>. */
export function AnimatedImage(props: AnimatedImageProps) {
  const [own, imgProps] = splitProps(props, ['still', 'ref']);
  const [, shared] = splitProps(props, ['src', 'alt', 'still', 'ref', 'loading', 'draggable']);
  const [player, setPlayer] = createSignal<Player | null>(null);
  const [img, setImg] = createSignal<HTMLImageElement>();

  // Opened the first time the picture is on screen: a log's rows and a picker's grid hold many off screen.
  createEffect(
    on([() => props.src, () => own.still, img], ([src, still, el]) => {
      setPlayer(null);
      if (still || !el) return;
      const onScreen = createOnScreen(el);
      let gone = false;
      let opened: Player | null = null;
      onCleanup(() => {
        gone = true;
        closePlayer(opened);
      });
      createEffect(
        on(onScreen, (now, _, started) => {
          if (started || !now) return started;
          void openPlayer(src)
            .catch(() => null)
            .then((p) => {
              if (gone) return closePlayer(p);
              opened = p;
              setPlayer(p);
            });
          return true;
        }),
      );
    }),
  );

  return (
    <Show
      when={player()}
      keyed
      fallback={
        <img
          ref={(el) => {
            setImg(el);
            own.ref?.(el);
          }}
          {...imgProps}
        />
      }
    >
      {(p) => <Frames player={p} alt={props.alt} ref={own.ref} shared={shared} />}
    </Show>
  );
}

/** The animation on a canvas, from its first frame; the shown frame's remaining time is kept across a pause. */
function Frames(props: { player: Player; alt: string; ref?: AnimatedImageProps['ref']; shared: Shared }) {
  // Keyed by its player (AnimatedImage): a new one mounts a new canvas.
  const p = props.player;
  let canvas!: HTMLCanvasElement;
  let frame = 0;
  let plays = 1;
  /** What is left of the shown frame's time, in µs, and when it was last resumed. */
  let leftUs = p.firstUs;
  let resumedAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let playing = false;

  const draw = (image: CanvasImageSource): void => {
    const c = canvas.getContext('2d');
    c?.clearRect(0, 0, canvas.width, canvas.height);
    c?.drawImage(image, 0, 0);
  };
  const schedule = (): void => {
    resumedAt = performance.now();
    timer = setTimeout(() => void advance(), leftUs / US_PER_MS);
  };
  const advance = async (): Promise<void> => {
    const next = (frame + 1) % p.frames;
    // Its loops are done: it rests on its last frame.
    if (next === 0 && plays > p.repetitions) return void (playing = false);
    if (next === 0) plays++;
    const decoded = await p.decoder.decode({ frameIndex: next }).catch(() => null);
    if (!decoded) return void (playing = false);
    frame = next;
    draw(decoded.image);
    leftUs = shownUs(decoded.image.duration);
    decoded.image.close();
    if (playing) schedule();
  };
  const play = (): void => {
    if (playing) return;
    playing = true;
    schedule();
  };
  const pause = (): void => {
    if (!playing) return;
    playing = false;
    clearTimeout(timer);
    leftUs = Math.max(0, leftUs - (performance.now() - resumedAt) * US_PER_MS);
  };

  const mount = (el: HTMLCanvasElement): void => {
    canvas = el;
    el.width = p.first.width;
    el.height = p.first.height;
    // Drawn before it is on the page: the swap from the <img> shows no blank frame.
    draw(p.first);
    props.ref?.(el);
    const looking = createLooking(el);
    createEffect(() => (looking() ? play() : pause()));
  };
  onCleanup(() => {
    playing = false;
    clearTimeout(timer);
  });

  return (
    <canvas ref={mount} {...props.shared} role="img" aria-label={props.alt} />
  );
}

/** A custom emoji, animated ones playing only while the owner can look. */
export function EmojiImage(props: Omit<AnimatedImageProps, 'src' | 'still'> & { emoji: Pick<CustomEmoji, 'id' | 'animated'> }) {
  const [own, rest] = splitProps(props, ['emoji']);
  return <AnimatedImage src={emojiUrl(own.emoji)} still={!own.emoji.animated} {...rest} />;
}