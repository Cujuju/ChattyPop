// Missing declared registrations fail activation and discard its registrations. Descriptor checks enforce audiences.
import { describe, expect, it, onTestFinished } from 'vitest';
import { defineChannels, definePlugin, defineRuleFilter } from '@plugin-sdk/shared';
import { defineCorePlugin, type CoreContext, type ProviderImpl } from '@plugin-sdk/core';
import { testPlugin } from '@plugin-sdk/core/testing';
import { checkBundled } from '@shared/bundledCheck';
import type { PluginDescriptor } from '@shared/bundledTypes';
import { PluginInactiveError } from '@shared/pluginCall';

const DONE_MAX = 2;
const probe = definePlugin({
  manifest: { id: 'regprobe', name: 'Reg probe', version: '1', description: '' },
  providers: [{ id: 'regprobe', label: 'Reg probe', displayName: 'Reg probe', enabledByDefault: false }],
  rules: { filters: [defineRuleFilter({ type: 'regprobe.keep', label: 'Keep', hint: '', create: () => null, validate() {} })] },
  channels: defineChannels<{ core: { status(): string; done(key: string): string } }>()({
    core: { status: ['renderer'], done: { audiences: ['main'], completion: { max: DONE_MAX } } },
  }),
});
const provider: ProviderImpl = {
  create: () => ({ id: 'regprobe', maxInputChars: 1, complete: async () => ({ text: '' }), listModels: async () => [] }),
  status: async () => ({ available: true, detail: '', models: [] }),
};

/** The probe under the host; each activation registers everything but `status` while `serving` is false. */
function start() {
  const state = { serving: true, activation: 0 };
  let last!: CoreContext<typeof probe>;
  const t = testPlugin(
    defineCorePlugin(probe, (ctx) => {
      const n = ++state.activation;
      last = ctx;
      ctx.ai.registerProvider('regprobe', provider);
      ctx.rules.filter('regprobe.keep', { test: () => true });
      ctx.completions.handle('done', { key: (key) => key }, ([key]) => `activation ${n} took ${key}`);
      ctx.completions.dispatch('done', `k${n}`, () => undefined);
      if (state.serving) ctx.channels.serve({ status: () => 'ok' });
    }),
  );
  onTestFinished(() => t.dispose());
  const providerRuns = (): boolean => t.ai.unavailable('regprobe') === null;
  const filterRegistered = (): boolean => t.rules.unavailable('filters', 'regprobe.keep') === null;
  return { t, state, providerRuns, filterRegistered, ctx: () => last };
}

describe('a core activation missing a declared registration', () => {
  it('fails, naming what is missing, and keeps nothing it registered', async () => {
    const h = start();
    await h.t.off();
    h.state.serving = false;
    await h.t.on();
    expect(h.t.status()).toEqual({ status: 'error', error: 'regprobe declares but never registered: core call status' });
    expect(h.providerRuns()).toBe(false);
    expect(h.filterRegistered()).toBe(false);
    await expect(h.t.client('renderer').status()).rejects.toBeInstanceOf(PluginInactiveError);
    // Its handler was never adopted: the last good activation's takes every issued key, the failed one's work included.
    await expect(h.t.client('main').done('k1')).resolves.toBe('activation 1 took k1');
    await expect(h.t.client('main').done('k2')).resolves.toBe('activation 1 took k2');
  });

  it('succeeds with everything registered, whose completion handlers are set during activate only', () => {
    const h = start();
    expect(h.t.status()).toEqual({ status: 'active', error: null });
    expect(h.providerRuns()).toBe(true);
    expect(h.filterRegistered()).toBe(true);
    expect(() => h.ctx().completions.handle('done', { key: (key) => key }, () => 'late')).toThrow(/during activate/);
  });

  it('fails for a plugin without a core side that declares what only a core side registers', () => {
    const t = testPlugin(probe);
    onTestFinished(() => t.dispose());
    expect(t.status().status).toBe('error');
    expect(t.status().error).toMatch(/never registered: core call status, completion handler done, rule filters regprobe.keep, AI provider regprobe/);
  });
});

describe('checkBundled audiences', () => {
  const withChannels = (audiences: Record<string, Record<string, unknown>>): PluginDescriptor =>
    ({ manifest: { id: 'chk', name: 'chk', version: '1', description: '' }, channels: { audiences } }) as never;

  it('refuses a member without audiences, an audience its section can’t have, an unknown section, a report outside core', () => {
    expect(() => checkBundled([withChannels({ core: { a: { audiences: ['renderer', 'phone', 'main'], writes: false } }, main: { b: ['renderer'] }, events: { c: ['main'] } })])).not.toThrow();
    expect(() => checkBundled([withChannels({ core: { a: [] } })])).toThrow(/needs at least one audience/);
    expect(() => checkBundled([withChannels({ core: { a: ['window'] } })])).toThrow(/window can't reach it/);
    expect(() => checkBundled([withChannels({ main: { b: ['phone'] } })])).toThrow(/phone can't reach it/);
    expect(() => checkBundled([withChannels({ calls: { a: ['renderer'] } })])).toThrow(/no section calls/);
    expect(() => checkBundled([withChannels({ events: { c: { audiences: ['main'], completion: { max: 1 } } } })])).toThrow(/only core members are completion reports/);
  });
});
