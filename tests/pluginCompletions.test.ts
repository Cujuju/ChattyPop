// Completion reports (docs/plugin-architecture.md §3): declared main-only members, the host's ledger of issued keys, and
// the finalizer that is a report's only grant once its plugin is off.
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { defineChannels, definePlugin, definePreference } from '@plugin-sdk/shared';
import { defineCorePlugin, type CoreContext, type CoreFinalize } from '@plugin-sdk/core';
import { testPlugin } from '@plugin-sdk/core/testing';
import { checkBundled } from '@shared/bundledCheck';
import type { PluginDescriptor } from '@shared/bundledTypes';
import { PluginInactiveError } from '@shared/pluginCall';

interface Core {
  ask(n: number): number;
  done(key: string, value: number): string;
}
interface Events {
  finished: string;
}
/** The declared bound of `done`'s ledger. */
const DONE_MAX = 2;
const probe = definePlugin({
  manifest: { id: 'probe', name: 'probe', version: '1', description: '' },
  channels: defineChannels<{ core: Core; events: Events }>()({
    core: { ask: ['renderer'], done: { audiences: ['main'], completion: { max: DONE_MAX } } },
    events: { finished: ['main'] },
  }),
  preferences: { touched: definePreference({ default: false, normalize: (v: unknown) => v === true }) },
});
type Ctx = CoreContext<typeof probe>;

/** The probe under the host: `activate` runs after it serves `ask` and creates its table. */
function start(activate: (ctx: Ctx) => void) {
  const t = testPlugin(
    defineCorePlugin(probe, (ctx) => {
      ctx.storage.migrate([`CREATE TABLE ${ctx.storage.table('rows')} (v TEXT)`]);
      ctx.channels.serve({ ask: (n) => n + 1 });
      activate(ctx);
    }),
  );
  onTestFinished(() => t.dispose());
  /** Main's report, as main's client sends it. */
  const report = (key: string, value: number) => t.client('main').done(key, value);
  return { t, report, rows: () => t.db.prepare('SELECT v FROM p_probe_rows').pluck().all() };
}
const done = vi.fn(([key]: [string, number]) => `handled ${key}`);
const handle = (ctx: Ctx, accept?: (key: string) => boolean): void => ctx.completions.handle('done', { key: (key) => key, accept }, (args) => done(args));

describe('completion reports', () => {
  it('run their handler once per issued key, apart from the calls serve covers; anything else resolves undefined', async () => {
    done.mockClear();
    const h = start((ctx) => {
      handle(ctx);
      ctx.completions.dispatch('done', 'k1', () => undefined);
    });
    await expect(h.report('k1', 1)).resolves.toBe('handled k1');
    await expect(h.report('k1', 1)).resolves.toBeUndefined();
    await expect(h.report('forged', 1)).resolves.toBeUndefined();
    expect(done).toHaveBeenCalledOnce();
    await expect((h.t.client('renderer') as unknown as Core).done('k1', 1)).rejects.toThrow(/no function done for renderer/);
  });

  it('refuse a key past the declared max, never dropping one issued, until one is reported or withdrawn', async () => {
    const issued: boolean[] = [];
    let completions!: Parameters<Parameters<typeof start>[0]>[0]['completions'];
    const h = start((ctx) => {
      handle(ctx);
      completions = ctx.completions;
      for (let i = 0; i <= DONE_MAX; i++) issued.push(ctx.completions.dispatch('done', `k${i}`, () => undefined));
    });
    expect(issued).toEqual([...Array<boolean>(DONE_MAX).fill(true), false]);
    // The oldest completion counts despite delayed reporting.
    await expect(h.report('k0', 1)).resolves.toBe('handled k0');
    await expect(h.report(`k${DONE_MAX}`, 1)).resolves.toBeUndefined();
    expect(completions.dispatch('done', 'next', () => undefined)).toBe(true);
    expect(completions.dispatch('done', 'over', () => undefined)).toBe(false);
    completions.withdraw('done', 'k1');
    await expect(h.report('k1', 1)).resolves.toBeUndefined();
    expect(completions.dispatch('done', 'over', () => undefined)).toBe(true);
  });

  it('free the key of a send that throws, so failed hand-overs never use up the max', async () => {
    let completions!: Parameters<Parameters<typeof start>[0]>[0]['completions'];
    const h = start((ctx) => {
      handle(ctx);
      completions = ctx.completions;
    });
    const failing = (): never => {
      throw new Error('hold insert failed');
    };
    for (let i = 0; i <= DONE_MAX; i++) expect(() => completions.dispatch('done', `f${i}`, failing)).toThrow('hold insert failed');
    await expect(h.report('f0', 1)).resolves.toBeUndefined();
    expect(completions.dispatch('done', 'ok', () => undefined)).toBe(true);
    // A key already out keeps its place when a second hand-over of it fails.
    expect(() => completions.dispatch('done', 'ok', failing)).toThrow();
    await expect(h.report('ok', 1)).resolves.toBe('handled ok');
  });

  it('take work the plugin accepts as persisted without an issued key', async () => {
    const h = start((ctx) => handle(ctx, (key) => key === 'stored'));
    await expect(h.report('stored', 1)).resolves.toBe('handled stored');
    await expect(h.report('other', 1)).resolves.toBeUndefined();
  });

  it('once the plugin is off, finalize only through the grant, which closes when the handler returns', async () => {
    let kept: CoreFinalize<typeof probe> | null = null;
    const h = start((ctx) => {
      ctx.completions.dispatch('done', 'k1', () => undefined);
      ctx.completions.handle('done', { key: (key) => key }, ([key], f) => {
        f.db.prepare('INSERT INTO p_probe_rows (v) VALUES (?)').run(key);
        f.channels.emit('finished', key);
        ctx.channels.emit('finished', 'through the retired context');
        ctx.preferences.set('touched', true);
        kept = f;
        return 'ok';
      });
    });
    await h.t.off();
    await expect(h.report('k1', 1)).resolves.toBe('ok');
    expect(h.rows()).toEqual(['k1']);
    expect(h.t.events('finished')).toEqual(['k1']);
    expect(h.t.preferences.get('touched')).toBe(false);
    const late = kept!;
    expect(() => late.db.prepare('INSERT INTO p_probe_rows (v) VALUES (?)').run('late')).toThrow(PluginInactiveError);
    late.channels.emit('finished', 'late');
    expect(h.t.events('finished')).toEqual(['k1']);
    expect(late.db.prepare('SELECT v FROM p_probe_rows').pluck().all()).toEqual(['k1']);
  });

  it('are inactive while off when no activation of this core process handled them', async () => {
    const h = start(() => undefined);
    await h.t.off();
    await expect(h.report('k1', 1)).rejects.toBeInstanceOf(PluginInactiveError);
  });

  it('are declared main-only with a positive bound', () => {
    const declare = (member: unknown): PluginDescriptor[] => [{ manifest: probe.manifest, channels: { audiences: { core: { done: member } } } } as PluginDescriptor];
    expect(() => checkBundled(declare({ audiences: ['renderer'], completion: { max: 1 } }))).toThrow(/must be main-only/);
    expect(() => checkBundled(declare({ audiences: ['main'], completion: { max: 0 } }))).toThrow(/positive integer/);
    expect(() => checkBundled(declare({ audiences: ['main'], completion: { max: 1 } }))).not.toThrow();
    defineChannels<{ core: Core }>()({
      // @ts-expect-error a completion report is main-only
      core: { ask: ['renderer'], done: { audiences: ['renderer'], completion: { max: 1 } } },
    });
    start((ctx) => {
      // @ts-expect-error serve covers ordinary calls only; reports go through ctx.completions
      ctx.channels.serve({ ask: (n) => n, done: () => '' });
    });
  });
});
