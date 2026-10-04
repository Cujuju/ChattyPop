// Compile-time probe: a window reads and writes a declared preference with its declared type; an undeclared name or a
// wrong value fails to compile (docs/plugin-architecture.md §4).
import { definePlugin, definePreference, finiteOr } from '@plugin-sdk/shared';
import { pluginPreference } from '@plugin-sdk/renderer';

const plugin = definePlugin({
  manifest: { id: 'typed', name: 'Typed', version: '1', description: '' },
  preferences: { count: definePreference<number | null>({ default: null, normalize: finiteOr(null) }) },
});

const [count, setCount] = pluginPreference(plugin, 'count');
export const read: number | null = count();
setCount(3);
// @ts-expect-error: a string is not the declared number | null
setCount('three');
// @ts-expect-error: no preference of that name
pluginPreference(plugin, 'missing');
