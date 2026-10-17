// A plugin's cleanup that throws while it turns off: every registration still goes, every later cleanup still runs.
import { describe, expect, it } from 'vitest';
import { definePlugin } from '@plugin-sdk/shared';
import { defineCorePlugin, type LlmProvider, type ProviderImpl } from '@plugin-sdk/core';
import { setSetting } from '../src/core/db';
import { tempDb } from './helpers';
import { startProviders } from './providerHost';

const probe = definePlugin({
  manifest: { id: 'probe', name: 'Probe', version: '1', description: '' },
  providers: [
    { id: 'probe', label: 'Probe · remote', displayName: 'Probe', enabledByDefault: true },
    { id: 'probe.local', label: 'Probe · local', displayName: 'Local probe', enabledByDefault: true, local: true },
  ],
});
const other = definePlugin({
  manifest: { id: 'other', name: 'Other', version: '1', description: '' },
  providers: [{ id: 'other', label: 'Other', displayName: 'Other', enabledByDefault: true }],
});

/** A provider whose completions wait until their signal aborts, keeping each signal in `signals`. */
function held(id: string, signals: AbortSignal[], dispose?: () => void): ProviderImpl {
  const provider: LlmProvider = {
    id,
    maxInputChars: 1,
    complete: (req) => {
      signals.push(req.signal!);
      return new Promise((_, reject) => req.signal?.addEventListener('abort', () => reject(req.signal?.reason)));
    },
    listModels: async () => [],
  };
  return { create: () => provider, status: async () => ({ available: true, detail: '', models: [] }), ...(dispose && { dispose }) };
}

describe("a plugin whose first provider's cleanup throws", () => {
  it('turns off with both providers revoked, its requests aborted, its own disposer run once; on again it registers both', async () => {
    const db = tempDb();
    setSetting(db, 'ai', { providers: { probe: { enabled: true }, 'probe.local': { enabled: true }, other: { enabled: true } } });
    const signals: AbortSignal[] = [];
    let disposerRuns = 0;
    let providerDisposals = 0;
    const probeCore = defineCorePlugin(probe, (ctx) => {
      ctx.ai.registerProvider('probe', held('probe', signals, () => {
        providerDisposals++;
        throw new Error('provider cleanup failed');
      }));
      ctx.ai.registerProvider('probe.local', held('probe.local', signals, () => void providerDisposals++));
      return () => void disposerRuns++;
    });
    const otherCore = defineCorePlugin(other, (ctx) => ctx.ai.registerProvider('other', held('other', [])));
    const { host, registry, ai } = startProviders([probeCore, otherCore], [probe, other], db);
    const running = [registry.get('probe', ai()).complete({ system: '', prompt: '' }), registry.get('probe.local', ai()).complete({ system: '', prompt: '' })];
    running.forEach((r) => r.catch(() => undefined));

    await expect(host.setEnabled('probe', false)).resolves.toBeUndefined();
    expect(host.list().find((p) => p.id === 'probe')?.status).toBe('disabled');
    expect([registry.runs('probe'), registry.runs('probe.local'), registry.runs('other')]).toEqual([false, false, true]);
    expect(signals.map((s) => s.aborted)).toEqual([true, true]);
    expect([providerDisposals, disposerRuns]).toEqual([2, 1]);

    await host.setEnabled('probe', true);
    expect([registry.runs('probe'), registry.runs('probe.local')]).toEqual([true, true]);
    expect(host.list().find((p) => p.id === 'probe')?.status).toBe('active');
  });
});
