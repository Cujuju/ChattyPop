// Live decoration probes: merged providers, failure isolation, disabled providers and channel races.
import { describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { LiveLabelProviders } from '../src/main/discord/labelProviders';
import { LiveLabels, LIVE_LABELS_CSS } from '../src/main/discord/liveLabels';

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
    it(
      'keeps the existing pill styling, joins labels, and clears the DOM map when providers turn off',
      async () => {
        const executeJavaScript = vi.fn(async (_script: string) => undefined);
        const insertCSS = vi.fn(async () => 'style');
        const page = {
          isDestroyed: () => false,
          executeJavaScript,
          insertCSS,
        } as unknown as WebContents;
        let labels: Record<string, string[]> = { m: ['A', 'B'] };
        const live = new LiveLabels(
          () => page,
          async () => labels,
          (error) => {
            throw new Error(error);
          },
        );
        live.showChannel('c');
        live.documentReady();
        await tick();
        expect(insertCSS).toHaveBeenCalledWith(LIVE_LABELS_CSS);
        expect(executeJavaScript.mock.calls.at(-1)?.[0]).toContain('"m":"A · B"');
        labels = {};
        live.changed();
        await tick();
        expect(executeJavaScript.mock.calls.at(-1)?.[0]).toContain('.set({})');
      },
    );
    it(
      'does not push a stale channel after its asynchronous provider returns',
      async () => {
        const executeJavaScript = vi.fn(async (_script: string) => undefined);
        const page = {
          isDestroyed: () => false,
          executeJavaScript,
        } as unknown as WebContents;
        let finish!: (value: Record<string, string[]>) => void;
        const slow = new Promise<Record<string, string[]>>((resolve) => {
          finish = resolve;
        });
        const live = new LiveLabels(() => page, (id) => id === 'old' ? slow : Promise.resolve({ fresh: ['new'] }), () => undefined);
        live.showChannel('old');
        await tick();
        live.showChannel('new');
        finish({ stale: ['old'] });
        await tick();
        expect(executeJavaScript).toHaveBeenCalledTimes(1);
        expect(executeJavaScript.mock.calls[0]?.[0]).toContain('"fresh":"new"');
      },
    );
  },
);
