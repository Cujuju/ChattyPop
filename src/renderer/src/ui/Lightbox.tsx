import { onCleanup } from '@plugin-sdk/renderer/containment';
import { Show, createEffect, on } from 'solid-js';
import { lightbox, setLightbox } from '@/state/ui';
import { stepLightbox } from '@/state/lightbox';
import { setOverlayCover } from '@/state/windows';
import { AnimatedImage } from './AnimatedImage';
import { createZoom } from './createZoom';
import { Icon } from './icons';
import styles from './Lightbox.module.css';

const LIGHTBOX_COVER = 'lightbox';
/** The backdrop has faded out once the image is dragged down this share of the window's height. */
const PULL_FADE_WINDOW_SHARE = 0.5;

/** Fullscreen image viewer closes via Escape/backdrop/button/fitted downward drag. Pinch/wheel zoom, zoomed drag pans and double activation toggles fit. */
export function Lightbox() {
  let dialog!: HTMLDialogElement;
  const step = (direction: -1 | 1): void => {
    const gallery = lightbox()?.gallery;
    if (!(direction < 0 ? gallery?.prev : gallery?.next)) return;
    zoom.reset();
    stepLightbox(direction);
  };
  const zoom = createZoom(() => setLightbox(null), step);
  const pullProgress = (): number => Math.min(1, zoom.pull() / (window.innerHeight * PULL_FADE_WINDOW_SHARE));
  createEffect(() => {
    if (lightbox() && !dialog.open) dialog.showModal();
    else if (!lightbox() && dialog.open) dialog.close();
  });
  // Each image opens fitted.
  createEffect(on(() => lightbox()?.src, () => {
    zoom.reset();
    queueMicrotask(() => { if (dialog.open && !dialog.contains(document.activeElement)) dialog.focus(); });
  }));
  // Over the whole window, the live Discord view (a native layer above the page) included.
  createEffect(() => setOverlayCover(LIGHTBOX_COVER, lightbox() ? 'window' : null));
  onCleanup(() => setOverlayCover(LIGHTBOX_COVER, null));
  return (
    <dialog
      ref={dialog}
      class={styles.dialog}
      aria-label={lightbox()?.kind === 'video' ? 'Video viewer' : 'Image viewer'}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        if (lightbox()?.gallery && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
          e.preventDefault();
          step(e.key === 'ArrowLeft' ? -1 : 1);
        }
      }}
      onCancel={(e) => { e.preventDefault(); setLightbox(null); }}
      style={{ '--lightbox-pull': String(pullProgress()) }}
      onClose={() => setLightbox(null)}
      // A click on the backdrop lands on the dialog itself; clicks on the image or links don't close it.
      onClick={(e) => e.target === e.currentTarget && setLightbox(null)}
    >
      <Show when={lightbox()}>
        {(img) => (
          <figure class={styles.figure} onClick={(e) => e.target === e.currentTarget && setLightbox(null)}>
            <Show when={img().kind === 'video'} fallback={<AnimatedImage
              ref={(el) => zoom.bind(el)}
              class={styles.image}
              src={img().src}
              still={img().still}
              alt={img().alt}
              draggable={false}
              data-zoomed={zoom.zoom().scale > 1}
              data-gesturing={zoom.gesturing()}
              style={{ transform: `translate(${zoom.zoom().x}px, ${zoom.zoom().y + zoom.pull()}px) scale(${zoom.zoom().scale})` }}
            />}>
              <Show when={img().src} keyed>{(src) => <video class={styles.video} src={src} controls autoplay playsinline aria-label={img().alt}
                ref={(video) => onCleanup(() => { video.pause(); video.removeAttribute('src'); video.load(); })} />}</Show>
            </Show>
            <figcaption class={styles.caption}>
              <span class={styles.labels}>
                <span class={styles.name}>{img().caption}</span>
                <Show when={img().gallery?.details}>{(details) => <span class={styles.details}>{details()}</span>}</Show>
              </span>
              <Show when={img().originalUrl}>
                {(href) => (
                  <a class={styles.open} href={href()} target="_blank" rel="noreferrer">
                    Open original
                  </a>
                )}
              </Show>
            </figcaption>
            <Show when={img().gallery}>
              {(gallery) => <>
                <span class={styles.counter} aria-live="polite">{gallery().position}</span>
                <Show when={gallery().prev}><button type="button" class={`${styles.round} ${styles.prev}`} aria-label="Previous file" onClick={() => step(-1)}><Icon name="chevronLeft" /></button></Show>
                <Show when={gallery().next}><button type="button" class={`${styles.round} ${styles.next}`} aria-label="Next file" onClick={() => step(1)}><Icon name="chevronRight" /></button></Show>
              </>}
            </Show>
            <button type="button" class={`${styles.round} ${styles.close}`} aria-label={img().kind === 'video' ? 'Close video' : 'Close image'} onClick={() => setLightbox(null)}>
              <Icon name="close" />
            </button>
          </figure>
        )}
      </Show>
    </dialog>
  );
}
