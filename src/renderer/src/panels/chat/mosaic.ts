// Discord's media mosaic: how a message's images and videos share one grid.
import { attachmentView } from '@shared/media';

/** Tiles in a full row of the mosaic. */
const ROW_TILES = 3;
/** Three tiles are one large beside two stacked, not one row. */
const FEATURE_COUNT = 3;
/** Four tiles sit two by two, not as one over three. */
const SQUARE_COUNT = 4;
const PAIR_TILES = 2;

/**
 * Tiles per row, top to bottom, for `n` tiles: rows of three, the remainder (one or two) leading; four is two by two.
 * Three is one then two, which the stylesheet lays side by side (one large, two stacked), as Discord does.
 */
export function mosaicRows(n: number): number[] {
  if (n <= 0) return [];
  if (n === FEATURE_COUNT) return [1, PAIR_TILES];
  if (n === SQUARE_COUNT) return [PAIR_TILES, PAIR_TILES];
  const lead = n % ROW_TILES;
  return [...(lead ? [lead] : []), ...Array<number>(Math.floor(n / ROW_TILES)).fill(ROW_TILES)];
}

/** Whether an attachment takes a mosaic tile: a stored image or video. */
export const inMosaic = (a: { status: string; contentType: string | null; filename: string }): boolean => {
  const view = attachmentView(a);
  return view === 'image' || view === 'video';
};
