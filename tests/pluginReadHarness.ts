// Shared lifecycle and database fixture for plugin read-point contracts.
import { ProviderRegistry } from '../src/core/ai/registry';
import { afterEach } from 'vitest';
import { defineChannels, definePlugin, defineRuleFilter } from '@plugin-sdk/shared';
import { defineCorePlugin, type CoreContext } from '@plugin-sdk/core';
import type { AppEvent } from '@shared/contract';
import { DEFAULT_AI_SETTINGS } from '@shared/settings';
import { PluginHost } from '../src/core/plugins/host';
import { RuleKinds } from '../src/core/rules/kinds';
import { messagePage } from '../src/core/queries/messages';
import { setSetting } from '../src/core/db';
import { ARRIVAL } from '../src/core/arrival';
import { rawMessage, seedArchive, tempDb, tempDir } from './helpers';

/** Descriptor covering read contributions and memoized rule filters. */
export const probe = definePlugin({
  manifest: {
    id: 'readprobe',
    name: 'Read probe',
    version: '1',
    description: '',
  },
  search: {
    tokens: [{
      key: 'probe',
      description: 'Probed',
      value: 'probe',
    }],
  },
  rules: {
    filters: [defineRuleFilter({
      type: 'readprobe.memo',
      label: 'Memo',
      hint: '',
      create: () => null,
      validate() {},
    })],
  },
  channels: defineChannels<{ core: { person(id: string): { id: string } | null } }>()({ core: { person: ['renderer'] } }),
});
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

/** Starts the probe over a fresh archive and disposes it after each test. */
export function startReadProbe(activate: (ctx: CoreContext<typeof probe>) => void) {
  const db = tempDb();
  const archive = seedArchive(db, [{ id: 'c1' }]);
  const raw = rawMessage('c1', Date.now(), 'probe:off');
  archive.ingestMessages([raw], ARRIVAL.gateway);
  const events: AppEvent[] = [];
  let ctx!: CoreContext<typeof probe>;
  const kinds = new RuleKinds();
  const host = new PluginHost(
    tempDir(),
    {
      db,
      emit: (e) => events.push(e),
      changed: () => undefined,
      ai: async () => ({ text: '' }),
      decider: () => null,
      bundled: {
        rules: kinds,
        ready: () => db,
        archive: () => archive,
        mediaDir: tempDir(),
        attachmentsDir: tempDir(),
        pluginData: {
          root: tempDir(),
          unmoved: {},
        },
        storeText: () => undefined,
        storeLinkText: () => undefined, storeLinkImages: () => undefined,
        catchUp: () => undefined,
        saveSetting: (key, value) => setSetting(db, key, value),
        aiSettings: () => DEFAULT_AI_SETTINGS,
        providers: new ProviderRegistry(() => undefined),
        decider: () => null,
        now: Date.now,
      },
    },
    [defineCorePlugin(
      probe,
      (value) => {
        ctx = value;
        // What the probe declares, so its activation succeeds; `activate` replaces what its test exercises.
        ctx.channels.serve({ person: () => null });
        ctx.rules.filter('readprobe.memo', { test: () => true });
        activate(ctx);
      },
    )],
  );
  host.startBundled();
  stops.push(() => host.setEnabled('readprobe', false));
  return {
    db,
    raw,
    host,
    events,
    kinds,
    context: () => ctx,
    page: () => messagePage(
      db,
      {
        channelId: 'c1',
        limit: 10,
      },
    ),
  };
}
