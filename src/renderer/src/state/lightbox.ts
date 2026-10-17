import { createSignal } from 'solid-js';

export interface LightboxGallery {
  /** Absent while the file's place in the whole order isn't known. */
  position?: string;
  details?: string;
  prev?: () => void;
  next?: () => void;
  /** The viewer closed on this image, after focus returned to its opener; the gallery may move focus to the file shown. */
  closed?: () => void;
}

/** Stored media with optional gallery navigation; single-image callers need no gallery or kind. */
export interface LightboxImage {
  src: string;
  /** An animated image's still, shown while the owner can't look. */
  still?: string;
  alt: string;
  caption: string;
  kind?: 'image' | 'video';
  gallery?: LightboxGallery;
  originalUrl: string | null;
}
export const [lightbox, setLightbox] = createSignal<LightboxImage | null>(null);

export function stepLightbox(direction: -1 | 1): void {
  const gallery = lightbox()?.gallery;
  (direction < 0 ? gallery?.prev : gallery?.next)?.();
}
