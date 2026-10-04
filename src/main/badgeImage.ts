// The unread indicators' art, drawn into raw bitmaps (Electron's BGRA, premultiplied alpha) so no image files ship for it.
//
// Each unread kind has its own dot, told apart twice over: colour, and a fixed slot along the image's bottom edge.
// Chat takes the bottom-right corner in sky blue; alerts take the slot to its left in Discord's red. A slot never
// moves, so a lone alerts dot still sits left of the corner, and both dots fit side by side at 16 px.

import type { UnreadKind } from '@shared/unread';

/** A raw bitmap: `width × height` pixels, four bytes each (B, G, R, A). */
export interface Bitmap {
  width: number;
  height: number;
  data: Buffer;
}

type Bgr = readonly [number, number, number];

const BYTES_PER_PIXEL = 4;
const OPAQUE = 255;
/**
 * Dot colours, BGR byte order: the owner's choice of red for alerts (Discord's unread red, #f23f43) and sky blue for chat
 * (#38bdf8), unlike the icon's amber, violet and navy and far in hue from the red, so red-green colour blindness keeps
 * them apart.
 */
export const DOT_BGR: Record<UnreadKind, Bgr> = { chat: [0xf8, 0xbd, 0x38], alerts: [0x43, 0x3f, 0xf2] };
/** Slots counted from the bottom-right corner leftward: chat holds the corner, as the single dot did before alerts had one. */
const DOT_SLOT: Record<UnreadKind, number> = { chat: 0, alerts: 1 };
/** A dot's diameter as a share of the image's width: 7 px at 16 px, legible, and two fit with their gap. */
const DOT_SHARE = 0.44;
/** Clear space between neighbouring dots as a share of the width: about 2 px at 16 px, so two dots don't merge. */
const DOT_GAP_SHARE = 0.12;

/** How much of the pixel at (x, y) a circle covers: 1 inside, 0 outside, a one-pixel ramp at its edge (antialiasing). */
function coverage(x: number, y: number, cx: number, cy: number, r: number): number {
  const distance = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
  return Math.min(1, Math.max(0, r + 0.5 - distance));
}

/** Paints an opaque `bgr` circle over `data` (a `width`-pixel-wide bitmap's pixels), in place. */
function paintDot(data: Buffer, width: number, height: number, bgr: Bgr, cx: number, cy: number, r: number): void {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cover = coverage(x, y, cx, cy, r);
      if (cover === 0) continue;
      const at = (y * width + x) * BYTES_PER_PIXEL;
      // Premultiplied "over": the dot is opaque, so its premultiplied colour is its colour.
      for (let c = 0; c < bgr.length; c++) data[at + c] = Math.round(bgr[c]! * cover + data[at + c]! * (1 - cover));
      data[at + 3] = Math.round(OPAQUE * cover + data[at + 3]! * (1 - cover));
    }
  }
}

/** `bmp` with each of `kinds`' dots in its slot along the bottom edge; `bmp` itself is left as it was. */
export function withDots(bmp: Bitmap, kinds: readonly UnreadKind[]): Bitmap {
  const data = Buffer.from(bmp.data);
  const r = (bmp.width * DOT_SHARE) / 2;
  const pitch = bmp.width * (DOT_SHARE + DOT_GAP_SHARE);
  for (const kind of kinds) paintDot(data, bmp.width, bmp.height, DOT_BGR[kind], bmp.width - r - DOT_SLOT[kind] * pitch, bmp.height - r, r);
  return { ...bmp, data };
}

/** A transparent `size`-pixel square holding only `kinds`' dots: the taskbar's overlay icon. */
export const dotsBitmap = (size: number, kinds: readonly UnreadKind[]): Bitmap =>
  withDots({ width: size, height: size, data: Buffer.alloc(size * size * BYTES_PER_PIXEL) }, kinds);
