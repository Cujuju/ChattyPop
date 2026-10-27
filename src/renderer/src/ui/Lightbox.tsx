import { onCleanup } from '@plugin-sdk/renderer/containment';
import { Match, Show, Switch, createEffect, on, untrack } from 'solid-js';
import { FileIcon } from '@/panels/chat/FileIcon';
import { lightbox, setLightbox, type LightboxGallery, type LightboxImage } from '@/state/ui';
import { stepLightbox } from '@/state/lightbox';
import { setOverlayCover } from '@/state/windows';
import { AnimatedImage } from './AnimatedImage';
import { createZoom } from './createZoom';
import { FloatingWindow, WindowHeader } from './FloatingWindow';
import { Icon } from './icons';
import chrome from './WindowChrome.module.css';
import styles from './Lightbox.module.css';

const LIGHTBOX_COVER = 'lightbox';
/** The panel window's id; its moved position is remembered under it. */
const LIGHTBOX_PANEL = 'lightbox-panel';
/** What the viewer shows, in its labels. */
const KIND_NAME: Readonly<Record<NonNullable<LightboxImage['kind']>, string>> = { image: 'Image', video: 'Video', file: 'File' };
/** Text controls that keep the arrow keys. */
const PANEL_FIELDS = 'input, textarea, select, [contenteditable]';
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
  let shownGallery: LightboxGallery | undefined;
  createEffect(() => {
    const image = lightbox();
    if (image && !dialog.open) dialog.showModal();
    else if (!image && dialog.open) dialog.close();
    // After close() has returned focus to the opener, so the gallery's choice wins.
    if (!image) untrack(() => shownGallery?.closed?.());
    shownGallery = image?.gallery;
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
      aria-label={`${KIND_NAME[lightbox()?.kind ?? 'image']} viewer`}
      tabIndex={-1}
      onKeyDown={(e) => {
        // A focused video's own controls seek and set volume with the arrows; a panel's fields move the caret.
        if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.target instanceof HTMLMediaElement || (e.target as Element).closest(PANEL_FIELDS)) return;
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
            <Switch fallback={<AnimatedImage
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
              <Match when={img().kind === 'video'}>
                <Show when={img().src} keyed>{(src) => <video class={styles.video} src={src} controls autoplay playsinline aria-label={img().alt}
                  ref={(video) => onCleanup(() => { video.pause(); video.removeAttribute('src'); video.load(); })} />}</Show>
              </Match>
              <Match when={img().kind === 'file'}>
                <FileIcon kind={img().fileKind ?? 'unknown'} class={styles.fileIcon} />
              </Match>
            </Switch>
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
                <Show when={gallery().position}>{(position) => <span class={styles.counter} aria-live="polite">{position()}</span>}</Show>
                <Show when={gallery().prev}><button type="button" class={`${styles.round} ${styles.prev}`} aria-label="Previous file" onClick={() => step(-1)}><Icon name="chevronLeft" /></button></Show>
                <Show when={gallery().next}><button type="button" class={`${styles.round} ${styles.next}`} aria-label="Next file" onClick={() => step(1)}><Icon name="chevronRight" /></button></Show>
              </>}
            </Show>
            <button type="button" class={`${styles.round} ${styles.close}`} aria-label={`Close ${KIND_NAME[img().kind ?? 'image'].toLowerCase()}`} onClick={() => setLightbox(null)}>
              <Icon name="close" />
            </button>
          </figure>
        )}
      </Show>
      {/* Inside the modal viewer, so it isn't inert; keyed, so each image's panel is its own. */}
      <Show when={lightbox()?.panel} keyed>
        {(panel) => (
          <FloatingWindow id={LIGHTBOX_PANEL} open class={`${chrome.dialog} ${chrome.form}`} aria-label={panel.title} onClose={() => setLightbox(null)}>
            <WindowHeader title={panel.title} classes={chrome} closeLabel="Close" onClose={() => setLightbox(null)} />
            <div class={chrome.body}>{panel.content()}</div>
          </FloatingWindow>
        )}
      </Show>
    </dialog>
  );
}
