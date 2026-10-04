// Fixture descriptors for host tests: two provider plugins, a panel in presets' `provider` slot, a panel following that
// slot, two panels no preset holds, a plugin with one core read.
import { defineChannels, definePlugin } from '@plugin-sdk/shared';
import type { PanelDecl, PluginDescriptor } from '@shared/bundledTypes';

/** Panel fields these tests don't read. */
const PANEL_FIELDS = { importance: 'reference', dialog: false, iconPath: 'M4 4h16v16H4z' } as const;
const manifest = (id: string, name: string) => ({ id, name, version: '1.0.0', description: `Fixture: ${name}.` });

export const alpha = definePlugin({
  manifest: manifest('p2alpha', 'Alpha'),
  providers: [{ id: 'p2alpha', label: 'Alpha · fixture', displayName: 'Alpha', enabledByDefault: true }],
});

/** Two providers in one plugin: its own id, and a dotted one. */
export const beta = definePlugin({
  manifest: manifest('p2beta', 'Beta'),
  providers: [
    { id: 'p2beta', label: 'Beta · local', displayName: 'Beta', enabledByDefault: false, local: true },
    { id: 'p2beta.mini', label: 'Beta · mini', displayName: 'Mini', enabledByDefault: false },
  ],
});

/** The host presets' slot a plugin panel fills (Plan usage's id); the presets keep it whether or not it is built. */
export const USAGE_PANEL = 'provider';
/** A panel whose preset places follow USAGE_PANEL's slot. */
export const DIGEST_PANEL = 'p2digest';
/** Panels no preset holds: added from a panel menu. */
export const NOTES_PANEL = 'p2notes';
export const EXTRA_PANEL = 'p2extra';

export const digest = definePlugin({
  manifest: manifest('p2digest', 'Digest'),
  panels: [{
    id: DIGEST_PANEL,
    title: 'Digest',
    ...PANEL_FIELDS,
    after: 'sync-status',
    presets: [{ id: 'stacked', after: USAGE_PANEL }, { id: 'side-by-side', after: USAGE_PANEL }, { id: 'tabbed', before: 'chat' }],
  }],
});

/** Anchored on another plugin's panel, so leaving that one out moves it to that panel's own anchor. */
export const usage = definePlugin({
  manifest: manifest('p2usage', 'Usage'),
  panels: [{ id: USAGE_PANEL, title: 'Usage', ...PANEL_FIELDS, after: DIGEST_PANEL }],
});

export const notes = definePlugin({
  manifest: manifest('p2notes', 'Notes'),
  panels: [{ id: NOTES_PANEL, title: 'Notes', ...PANEL_FIELDS, after: 'chat' }, { id: EXTRA_PANEL, title: 'Extra', ...PANEL_FIELDS, after: NOTES_PANEL }],
});

/** A ranged read, as a panel's resource asks it. */
export interface RangeQuery {
  scope?: string;
  sinceTs?: number;
}
interface ReaderCalls {
  read(q: RangeQuery): string;
}
/** A plugin whose renderer side loads its one core read, desktop windows only, as a resource. */
export const reader = definePlugin({
  manifest: manifest('p2reader', 'Reader'),
  channels: defineChannels<{ core: ReaderCalls }>()({ core: { read: ['renderer'] } }),
});

/** Every fixture provider and panel plugin, in build order. */
export const FIXTURE_PLUGINS: readonly PluginDescriptor[] = [alpha, beta, digest, usage, notes];

/** The panels `plugins` declare. */
export const panelsOf = (plugins: readonly PluginDescriptor[]): PanelDecl[] => plugins.flatMap((p) => p.panels ?? []);
