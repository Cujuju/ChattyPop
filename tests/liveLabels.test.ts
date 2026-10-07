// Live decoration probes: merged providers, failure isolation, disabled providers, channel races, and pills drawn by CSS alone.
import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { LiveLabelProviders } from '../src/main/discord/labelProviders';
import { LiveLabels, liveLabelsCss } from '../src/main/discord/liveLabels';

const MICROTASK_TURNS = 10;
const tick = async (): Promise<void> => {
  for (let i = 0; i < MICROTASK_TURNS; i++) await Promise.resolve();
};

describe(
  'live label providers',
  () => {
    it(
      'merges two probe plugins, isolates a third failure, and removes an off provider',
      async () => {
        const active = new Set(['one', 'two', 'bad']);
        const failed = vi.fn();
        const providers = new LiveLabelProviders((id) => active.has(id), failed);
        providers.provide('one', async () => ({ m: ['Manual'] }));
        providers.provide(
          'two',
          async () => ({
            m: ['Jev'],
            n: ['Other'],
          }),
        );
        providers.provide(
          'bad',
          async () => {
            throw new Error('offline');
          },
        );
        expect(await providers.read('c')).toEqual({
          m: ['Manual', 'Jev'],
          n: ['Other'],
        });
        expect(failed).toHaveBeenCalledWith('bad', expect.any(Error));
        active.delete('one');
        expect(await providers.read('c')).toEqual({
          m: ['Jev'],
          n: ['Other'],
        });
        active.clear();
        expect(await providers.read('c')).toEqual({});
      },
    );
    it('draws pills from one stylesheet, replaces it on change, and removes it when providers turn off', async () => {
      const insertCSS = vi.fn(async (_css: string) => `key${insertCSS.mock.calls.length}`);
      const removeInsertedCSS = vi.fn(async (_key: string) => undefined);
      const page = { isDestroyed: () => false, insertCSS, removeInsertedCSS } as unknown as WebContents;
      let labels: Record<string, string[]> = { '1000000000000000111': ['A', 'B'] };
      const live = new LiveLabels(() => page, async () => labels, (error) => {
        throw new Error(error);
      });
      live.documentReady();
      live.showChannel('c');
      await tick();
      expect(insertCSS.mock.calls.at(-1)?.[0]).toContain('#message-content-1000000000000000111::after { content: "A · B"; }');
      labels = {};
      live.changed();
      await tick();
      expect(removeInsertedCSS).toHaveBeenLastCalledWith('key1');
      expect(insertCSS).toHaveBeenCalledTimes(1);
    });
    it('escapes label text and skips ids that are not snowflakes', () => {
      const css = liveLabelsCss({ '1000000000000000222': String.raw`say "hi" \ there` + '\nnow', 'x"]{}': 'bad' });
      expect(css).toContain(String.raw`#message-content-1000000000000000222::after { content: "say \"hi\" \\ there\a now"; }`);
      expect(css).not.toContain('bad');
      expect(liveLabelsCss({})).toBe('');
    });
    it(
      'does not push a stale channel after its asynchronous provider returns',
      async () => {
        const insertCSS = vi.fn(async (_css: string) => 'key');
        const page = {
          isDestroyed: () => false,
          insertCSS,
          removeInsertedCSS: async () => undefined,
        } as unknown as WebContents;
        let finish!: (value: Record<string, string[]>) => void;
        const slow = new Promise<Record<string, string[]>>((resolve) => {
          finish = resolve;
        });
        const live = new LiveLabels(() => page, (id) => id === 'old' ? slow : Promise.resolve({ '1000000000000000333': ['new'] }), () => undefined);
        live.showChannel('old');
        await tick();
        live.showChannel('new');
        finish({ '1000000000000000444': ['old'] });
        await tick();
        expect(insertCSS).toHaveBeenCalledTimes(1);
        expect(insertCSS.mock.calls[0]?.[0]).toContain('content: "new"');
      },
    );
  },
);
