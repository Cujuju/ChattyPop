import { Show, createEffect, on, onCleanup } from 'solid-js';
import { lightbox, setLightbox } from '@/state/ui';
import { setOverlayCover } from '@/state/windows';
import { createZoom } from './createZoom';
import { Icon } from './icons';
import styles from './Lightbox.module.css';

const LIGHTBOX_COVER = 'lightbox';
/** The backdrop has faded out once the image is dragged down this share of the window's height. */
const PULL_FADE_WINDOW_SHARE = 0.5;

/** Fullscreen image viewer closes via Escape/backdrop/button/fitted downward drag. Pinch/wheel zoom, zoomed drag pans and double activation toggles fit. */
export function Lightbox() {
  let dialog!: HTMLDialogElement;
  const zoom = createZoom(() => setLightbox(null));
  const pullProgress = (): number => Math.min(1, zoom.pull() / (window.innerHeight * PULL_FADE_WINDOW_SHARE));
  createEffect(() => {
    if (lightbox() && !dialog.open) dialog.showModal();
    else if (!lightbox() && dialog.open) dialog.close();
  });
  // Each image opens fitted.
  createEffect(on(lightbox, () => zoom.reset()));
  // Over the whole window, the live Discord view (a native layer above the page) included.
  createEffect(() => setOverlayCover(LIGHTBOX_COVER, lightbox() ? 'window' : null));
  onCleanup(() => setOverlayCover(LIGHTBOX_COVER, null));
  return (
    <dialog
      ref={dialog}
      class={styles.dialog}
      aria-label="Image viewer"
      style={{ '--lightbox-pull': String(pullProgress()) }}
      onClose={() => setLightbox(null)}
      // A click on the backdrop lands on the dialog itself; clicks on the image or links don't close it.
      onClick={(e) => e.target === e.currentTarget && setLightbox(null)}
    >
      <Show when={lightbox()}>
        {(img) => (
          <figure class={styles.figure} onClick={(e) => e.target === e.currentTarget && setLightbox(null)}>
            <img
              ref={(el) => zoom.bind(el)}
              class={styles.image}
              src={img().src}
              alt={img().alt}
              draggable={false}
              data-zoomed={zoom.zoom().scale > 1}
              data-gesturing={zoom.gesturing()}
              style={{ transform: `translate(${zoom.zoom().x}px, ${zoom.zoom().y + zoom.pull()}px) scale(${zoom.zoom().scale})` }}
            />
            <figcaption class={styles.caption}>
              <span class={styles.name}>{img().caption}</span>
              <Show when={img().originalUrl}>
                {(href) => (
                  <a class={styles.open} href={href()} target="_blank" rel="noreferrer">
                    Open original
                  </a>
                )}
              </Show>
            </figcaption>
            <button type="button" class={styles.close} aria-label="Close image" onClick={() => setLightbox(null)}>
              <Icon name="close" />
            </button>
          </figure>
        )}
      </Show>
    </dialog>
  );
}
