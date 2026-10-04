// A fixture descriptor listing one event for the phone and one not, to mock the build's registry. Imports no registry
// module, so a registry mock may load it.
import type { PluginDescriptor } from '@shared/bundledTypes';
import { defineChannels } from '@shared/pluginChannels';

/** One event listed for the phone, one for the desktop only. */
export const voice: PluginDescriptor = {
  manifest: { id: 'voice', name: 'voice', version: '1', description: '' },
  channels: defineChannels<{ events: { status: string; other: string } }>()({
    events: { status: ['renderer', 'phone'], other: ['renderer'] },
  }),
};

/** The registry the phone contract tests run over. */
export const PHONE_EVENTS: readonly PluginDescriptor[] = [voice];
