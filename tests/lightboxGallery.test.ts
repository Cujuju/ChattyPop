import { afterEach, describe, expect, it, vi } from 'vitest';
import { lightbox, setLightbox, stepLightbox, type LightboxGallery, type LightboxImage } from '../src/renderer/src/state/lightbox';

afterEach(() => setLightbox(null));
const image: LightboxImage = { src: 'stored:image', alt: 'Picture', caption: 'photo.png', originalUrl: null };

describe('the lightbox gallery contract', () => {
  it('keeps single-image callers valid and ignores missing directions', () => {
    setLightbox(image);
    stepLightbox(-1); stepLightbox(1);
    expect(lightbox()).toBe(image);
    expect(lightbox()?.kind).toBeUndefined();
  });
  it('hands navigation to the current gallery and permits a video in the image slot', () => {
    const next = vi.fn(() => setLightbox({ ...image, src: 'stored:video', kind: 'video', gallery: { position: '2 of 2', prev } }));
    const prev = vi.fn(() => setLightbox({ ...image, gallery }));
    const gallery: LightboxGallery = { position: '1 of 2', details: '2 MB · Alice · #general', next };
    setLightbox({ ...image, gallery });
    stepLightbox(-1);
    expect(next).not.toHaveBeenCalled();
    stepLightbox(1);
    expect(next).toHaveBeenCalledOnce();
    expect(lightbox()).toMatchObject({ kind: 'video', gallery: { position: '2 of 2' } });
    stepLightbox(1);
    expect(next).toHaveBeenCalledOnce();
    stepLightbox(-1);
    expect(prev).toHaveBeenCalledOnce();
    expect(lightbox()?.gallery?.details).toBe(gallery.details);
  });
  it('allows an unknown end and does not call a stale gallery after dismissal', () => {
    const next = vi.fn();
    setLightbox({ ...image, gallery: { position: '12', next } });
    expect(lightbox()?.gallery?.position).toBe('12');
    setLightbox(null);
    stepLightbox(1);
    expect(next).not.toHaveBeenCalled();
  });
});
