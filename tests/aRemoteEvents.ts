// A fixture descriptor with an event for windows and the phone, one for windows only and one for the phone only, to
// mock the build's registry. Imports no registry module, so a registry mock may load it.
import type { PluginDescriptor } from '@shared/bundledTypes';
import { defineChannels } from '@shared/pluginChannels';

export const relay: PluginDescriptor = {
  manifest: { id: 'relay', name: 'relay', version: '1', description: '' },
  channels: defineChannels<{ events: { both: string; desk: string; pocket: string } }>()({
    events: { both: ['renderer', 'phone'], desk: ['renderer'], pocket: ['phone'] },
  }),
};

/** The registry the remote desktop contract tests run over. */
export const REMOTE_EVENTS: readonly PluginDescriptor[] = [relay];
