// Fixture descriptors stating what the phone may read, call and hear: a test mocks the build's registry with them.
// Imports no registry module, so a registry mock may load it.
import type { PluginDescriptor } from '@shared/bundledTypes';
import { definePreference } from '@shared/preferences';
import { defineChannels } from '@shared/pluginChannels';

const manifest = (id: string) => ({ id, name: id, version: '1', description: '' });
const keep = <T>(fallback: T) => (v: unknown): T => (v === undefined ? fallback : (v as T));

/** Commands the phone's composer lists by prefix; who answers and the prompt stay on the PC. */
interface Commands {
  ask: { enabled: boolean; prefix: string; prompt?: string };
  query: { enabled: boolean; prefix: string; provider?: string };
}
const COMMANDS: Commands = { ask: { enabled: false, prefix: 'ask' }, query: { enabled: false, prefix: 'q' } };

/** Whole preferences the phone reads. */
export const inbox: PluginDescriptor = {
  manifest: manifest('inbox'),
  preferences: {
    sort: definePreference<string>({ default: 'time', normalize: keep('time'), phone: true }),
    ruleIds: definePreference<number[]>({ default: [], normalize: keep([]), phone: true }),
  },
};
/** A preference the phone reads only some nested fields of. */
export const commands: PluginDescriptor = {
  manifest: manifest('commands'),
  preferences: { commands: definePreference<Commands>({ default: COMMANDS, normalize: keep(COMMANDS), phone: ['ask.enabled', 'ask.prefix', 'query.enabled', 'query.prefix'] }) },
};
/** One preference read in part, one whole, one not at all. */
export const digest: PluginDescriptor = {
  manifest: manifest('digest'),
  preferences: {
    settings: definePreference<{ defaultRange: string; focus?: string }>({ default: { defaultRange: '24h' }, normalize: keep({ defaultRange: '24h' }), phone: ['defaultRange'] }),
    seenId: definePreference<number | null>({ default: null, normalize: keep(null), phone: true }),
    lastRunAt: definePreference<number | null>({ default: null, normalize: keep(null) }),
  },
};

interface VoiceCalls {
  status(): string;
  install(): void;
  audioFetched(): void;
}
/** Calls and events, some listed for the phone. */
export const voice: PluginDescriptor = {
  manifest: manifest('voice'),
  channels: defineChannels<{ core: VoiceCalls; events: { status: string; fetchAudio: string } }>()({
    core: { status: { audiences: ['renderer', 'phone'], writes: false }, install: ['renderer'], audioFetched: ['main'] },
    events: { status: ['renderer', 'phone'], fetchAudio: ['main'] },
  }),
};

/** The registry the phone tests run over. */
export const PHONE_CONTRACTS: readonly PluginDescriptor[] = [inbox, commands, digest, voice];
