// Compile-only contracts reject undeclared preferences, wrong value types, and invalid descriptor fields in core and main. pnpm typecheck validates them.
import { definePlugin, definePreference, finiteOr } from '@plugin-sdk/shared';
import type { CoreContext } from '@plugin-sdk/core';
import type { MainContext } from '@plugin-sdk/main';

const manifest = { id: 'typed', name: 'Typed', version: '1', description: '' };
const preferences = {
  count: definePreference<number | null>({ default: null, normalize: finiteOr(null), phone: true }),
  server: definePreference({ default: { url: '', nested: { on: false } }, normalize: (v: unknown) => ({ url: String(v), nested: { on: v === true } }), phone: ['nested.on'] }),
};
const plugin = definePlugin({
  manifest,
  preferences,
  network: { ownerUrls: [{ setting: 'server', field: 'url', fallback: 'http://127.0.0.1:1/' }] },
  adopts: { settings: { 'old.count': 'count' }, settingFields: [{ key: 'ai', field: 'url', name: 'server' }] },
});

declare const core: CoreContext<typeof plugin>;
export const count: number | null = core.preferences.get('count');
export const url: string = core.preferences.get('server').url;
core.preferences.set('server', { url: 'http://10.0.0.1/', nested: { on: true } });
core.preferences.onChange('count', (value: number | null) => void value);
// @ts-expect-error: no preference of that name
core.preferences.get('missing');
// @ts-expect-error: a string is not the declared number | null
core.preferences.set('count', 'three');
// @ts-expect-error: url is a string
core.preferences.set('server', { url: 1, nested: { on: true } });
// @ts-expect-error: onChange hands the declared type
core.preferences.onChange('count', (value: string) => void value);

declare const main: MainContext<typeof plugin>;
export const mainCount: Promise<number | null> = main.preferences.get('count');
// @ts-expect-error: a string is not the declared number | null
void main.preferences.set('count', 'three');
// @ts-expect-error: no preference of that name
main.preferences.onChange('missing', () => undefined);

// @ts-expect-error: a phone view names only fields of the value
definePreference({ default: { url: '' }, normalize: () => ({ url: '' }), phone: ['nope'] });

definePlugin({
  manifest,
  preferences,
  // @ts-expect-error: ownerUrls name a declared preference
  network: { ownerUrls: [{ setting: 'missing', field: 'url', fallback: 'http://127.0.0.1:1/' }] },
});
definePlugin({
  manifest,
  preferences,
  // @ts-expect-error: and a field of its value
  network: { ownerUrls: [{ setting: 'server', field: 'port', fallback: 'http://127.0.0.1:1/' }] },
});
definePlugin({
  manifest,
  preferences,
  // @ts-expect-error: adopted settings land on a declared preference
  adopts: { settings: { 'old.count': 'missing' } },
});
definePlugin({
  manifest,
  preferences,
  // @ts-expect-error: adopted fields land on a field of a declared preference
  adopts: { settingFields: [{ key: 'ai', field: 'port', name: 'server' }] },
});
// @ts-expect-error: a plugin without preferences adopts into none
definePlugin({ manifest, adopts: { settings: { 'old.count': 'count' } } });
