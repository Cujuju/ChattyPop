import { describe, expect, it } from 'vitest';
import { COMPONENT, componentsFrom } from '@shared/components';
import { mediaSize } from '@shared/media';
import { EMBED_GALLERY_MAX, embedsFrom } from '../src/core/queries/messageExtras';

// The view reserves each media box from these sizes before the file loads; without them the log row grows on load.
describe('media sizes', () => {
  it('reads a positive width and height, else null', () => {
    expect(mediaSize({ width: 640, height: 360 })).toEqual({ width: 640, height: 360 });
    expect(mediaSize({ width: 640 })).toBeNull();
    expect(mediaSize({ width: 0, height: 360 })).toBeNull();
    expect(mediaSize({ width: '640', height: 360 })).toBeNull();
    expect(mediaSize(undefined)).toBeNull();
  });

  it('carries Discord embed image, thumbnail and video sizes', () => {
    const json = JSON.stringify([
      {
        type: 'gifv',
        thumbnail: { proxy_url: 'https://media.discordapp.net/t.png', width: 498, height: 280 },
        video: { proxy_url: 'https://media.discordapp.net/v.mp4', width: 498, height: 280 },
      },
      { type: 'image', image: { proxy_url: 'https://media.discordapp.net/i.png' } },
    ]);
    const [gif, image] = embedsFrom(json);
    expect(gif).toMatchObject({ thumbnailSize: { width: 498, height: 280 }, videoSize: { width: 498, height: 280 }, imageSize: null });
    expect(image!.imageSize).toBeNull();
  });

  // Discord sends a multi-photo post as one embed per photo, all with the post's URL, and draws them as one card.
  describe('embeds sharing a URL', () => {
    const POST = 'https://fxtwitter.com/a/status/1';
    const photo = (n: number) => ({ proxy_url: `https://media.discordapp.net/p${n}.jpg`, width: 900, height: 1200 });

    it('are one card: the first keeps its text, the rest give their images', () => {
      const embeds = embedsFrom(
        JSON.stringify([
          { type: 'rich', url: POST, description: 'Two photos', footer: { text: 'FxTwitter' }, image: photo(1) },
          { type: 'rich', url: POST, image: photo(2) },
          { type: 'rich', url: 'https://example.com/other', title: 'Another link' },
        ]),
      );
      expect(embeds).toHaveLength(2);
      expect(embeds[0]).toMatchObject({ description: 'Two photos', footer: 'FxTwitter', imageUrl: photo(1).proxy_url });
      expect(embeds[0]!.moreImages).toEqual([{ url: photo(2).proxy_url, size: { width: 900, height: 1200 } }]);
      expect(embeds[1]).toMatchObject({ title: 'Another link' });
      expect(embeds[1]!.moreImages).toBeUndefined();
    });

    it("give a card with no image of its own the first later one, and stop at Discord's gallery limit", () => {
      const [card] = embedsFrom(JSON.stringify([{ type: 'rich', url: POST, description: 'Text first' }, ...[1, 2, 3, 4, 5, 6].map((n) => ({ type: 'rich', url: POST, image: photo(n) }))]));
      expect(card!.imageUrl).toBe(photo(1).proxy_url);
      expect(1 + card!.moreImages!.length).toBe(EMBED_GALLERY_MAX);
    });

    it('leaves embeds without a URL apart', () => {
      expect(embedsFrom(JSON.stringify([{ type: 'rich', image: photo(1) }, { type: 'rich', image: photo(2) }]))).toHaveLength(2);
    });
  });

  it('carries gallery item sizes', () => {
    const [gallery] = componentsFrom([
      { type: COMPONENT.gallery, items: [{ media: { proxy_url: 'https://media.discordapp.net/g.png', width: 800, height: 600 } }] },
    ]);
    expect(gallery).toEqual({ type: 'gallery', items: [{ url: 'https://media.discordapp.net/g.png', description: null, size: { width: 800, height: 600 } }] });
  });
});
