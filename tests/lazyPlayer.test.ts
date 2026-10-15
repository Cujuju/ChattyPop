// Looping media loaded on first look (Lottie stickers): a load finishing after the owner looked away leaves it paused.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// Uses Solid's browser runtime so effects run as in a window.
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
const { createRoot, createSignal } = createRequire(import.meta.url)('solid-js/dist/solid.cjs') as typeof import('solid-js');

interface Player {
  play(): void;
  pause(): void;
  destroy(): void;
}
// A renderer module: imported by path so the node type-check doesn't follow it.
const lazyPlayerPath = '../src/renderer/src/ui/lazyPlayer';
const { createLazyPlayer } = (await import(lazyPlayerPath)) as {
  createLazyPlayer(looking: () => boolean, wanted: () => boolean, load: () => Promise<Player | null>): () => Player | undefined;
};

const settle = (): Promise<void> => new Promise((r) => setTimeout(r));

/** A sticker whose load the test finishes, with what its player was told, in order. */
function sticker() {
  const calls: string[] = [];
  const player: Player = { play: () => calls.push('play'), pause: () => calls.push('pause'), destroy: () => calls.push('destroy') };
  let finish!: (p: Player | null) => void;
  const load = vi.fn(() => new Promise<Player | null>((r) => (finish = r)));
  const [looking, setLooking] = createSignal(true);
  const [wanted, setWanted] = createSignal(true);
  const dispose = createRoot((d) => {
    createLazyPlayer(looking, wanted, load);
    return d;
  });
  return { calls, load, finish: (p: Player | null = player) => finish(p), setLooking, setWanted, dispose };
}

describe('a lazily loaded player', () => {
  it('hidden before its load finished: stays paused once loaded, and plays when looked at again', async () => {
    const s = sticker();
    s.setLooking(false);
    s.finish();
    await settle();
    expect(s.calls).toEqual(['pause']);
    s.setLooking(true);
    expect(s.calls).toEqual(['pause', 'play']);
  });

  it('hover left before its load finished: stays paused once loaded', async () => {
    const s = sticker();
    s.setWanted(false);
    s.finish();
    await settle();
    expect(s.calls).toEqual(['pause']);
  });

  it('loads once, on first look', async () => {
    const s = sticker();
    s.setLooking(false);
    s.setLooking(true);
    expect(s.load).toHaveBeenCalledOnce();
  });

  it('a load finishing after disposal is destroyed, never played', async () => {
    const s = sticker();
    s.dispose();
    s.finish();
    await settle();
    expect(s.calls).toEqual(['destroy']);
  });
});
