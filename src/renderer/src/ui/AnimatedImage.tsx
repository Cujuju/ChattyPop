// Animated pictures (GIF, APNG, animated WebP) as Discord shows them: animated while the owner can look (looking.ts),
// else its still (the first frame), which the host serves.
import { createEffect, createSignal, on, splitProps, type Accessor, type JSX } from 'solid-js';
import { emojiUrl, type CustomEmoji } from '@shared/emoji';
import { createLooking } from './looking';

export interface AnimatedImageProps extends Omit<JSX.ImgHTMLAttributes<HTMLImageElement>, 'src' | 'ref' | 'onError'> {
  src: string | undefined;
  /** The still shown while the owner can't look; none: always `src`. */
  still?: string;
  ref?: (el: HTMLImageElement) => void;
}

/** An <img> that is animated only while the owner can look at it. A still that fails to load gives way to `src`. */
export function AnimatedImage(props: AnimatedImageProps) {
  const [own, rest] = splitProps(props, ['src', 'still', 'ref']);
  const [looking, setLooking] = createSignal<Accessor<boolean>>(() => false);
  const [stillFailed, setStillFailed] = createSignal(false);
  createEffect(on(() => own.still, () => setStillFailed(false), { defer: true }));
  const shown = (): string | undefined => (own.still && !stillFailed() && !looking()() ? own.still : own.src);
  return (
    <img
      {...rest}
      ref={(el) => {
        setLooking(() => createLooking(el));
        own.ref?.(el);
      }}
      src={shown()}
      onError={() => own.still && shown() === own.still && setStillFailed(true)}
    />
  );
}

/** A custom emoji, an animated one moving only while the owner can look. */
export function EmojiImage(props: Omit<AnimatedImageProps, 'src' | 'still'> & { emoji: Pick<CustomEmoji, 'id' | 'animated'> }) {
  const [own, rest] = splitProps(props, ['emoji']);
  return <AnimatedImage {...rest} src={emojiUrl(own.emoji)} still={own.emoji.animated ? emojiUrl({ id: own.emoji.id, animated: false }) : undefined} />;
}
