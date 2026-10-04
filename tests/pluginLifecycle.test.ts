// Bundled plugins' on/off lifecycle covers every descriptor in the build, including ones with no core side.
import { describe, expect, it, onTestFinished } from 'vitest';
import { definePlugin } from '@plugin-sdk/shared';
import { defineCorePlugin } from '@plugin-sdk/core';
import { PluginHost } from '../src/core/plugins/host';
import { testPlugin } from '@plugin-sdk/core/testing';
import { tempDb, tempDir } from './helpers';

/** A panel-only descriptor: contributions, no core side. */
const panelOnly = definePlugin({
  manifest: { id: 'panelonly', name: 'Panel only', version: '1', description: '' },
  panels: [{ id: 'panelonly-view', title: 'Panel only', importance: 'reference', dialog: false, iconPath: 'M3 3h18', after: 'sync-status' }],
});
const viewOnly = definePlugin({ manifest: { id: 'viewonly', name: 'View only', version: '1', description: '' } });

/** This build's descriptors, neither with a core side. */
function host() {
  return new PluginHost(
    tempDir(),
    { db: tempDb(), emit: () => undefined, changed: () => undefined, ai: async () => ({ text: '' }), decider: () => null },
    [],
    [panelOnly, viewOnly],
  );
}

describe('a bundled plugin without a core side', () => {
  it('is listed as on, in build order, and turns off and on like any other', async () => {
    const h = host();
    h.startBundled();
    expect(h.list().map((p) => [p.id, p.status, p.bundled])).toEqual([['panelonly', 'active', true], ['viewonly', 'active', true]]);
    await h.setEnabled('panelonly', false);
    expect(h.list().find((p) => p.id === 'panelonly')?.status).toBe('disabled');
    await h.setEnabled('panelonly', true);
    expect(h.list().find((p) => p.id === 'panelonly')?.status).toBe('active');
  });
});

describe('the archive closing (a move)', () => {
  it('ends every activation first, leaving switches and continuity for the restart', () => {
    const probe = definePlugin({ manifest: { id: 'probe', name: 'Probe', version: '1', description: '' } });
    const lifetimes: AbortSignal[] = [];
    const resumed: boolean[] = [];
    /** At each activation: whether every earlier one had ended. */
    const endedBefore: boolean[] = [];
    const core = defineCorePlugin(probe, (ctx) => {
      endedBefore.push(lifetimes.every((signal) => signal.aborted));
      lifetimes.push(ctx.lifetime.signal);
      resumed.push(ctx.session.resumed);
    });
    const first = testPlugin(core);
    // The restart: every activation ends first; then the plugin is on and continues its previous activation.
    const next = first.restart();
    onTestFinished(() => next.dispose());
    expect(endedBefore).toEqual([true, true]);
    expect(lifetimes[0]?.aborted).toBe(true);
    expect(resumed).toEqual([false, true]);
  });
});
