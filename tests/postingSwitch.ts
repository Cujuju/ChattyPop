// Mocks plugin lists and bundled descriptors with one posting-unlocking fixture, allowing renderer tests to flip the gate.
import { createRequire } from 'node:module';

// Uses Solid’s browser runtime so reactive state runs as in a window.
const { createSignal } = createRequire(import.meta.url)('solid-js/dist/solid.cjs') as typeof import('solid-js');

const UNLOCKER = 'posting-unlocker';
const [on, setOn] = createSignal(true);

/** Turns the unlocking fixture plugin on (unlocked) or off (locked). Starts unlocked. */
export const setPostingUnlocked = (unlocked: boolean): void => void setOn(unlocked);

/** For `virtual:bundled-plugins/shared`: the fixture plugin's descriptor. */
export const bundledPluginsModule = {
  default: [{ manifest: { id: UNLOCKER, name: UNLOCKER, version: '1.0.0', description: '' }, unlocks: { posting: true } }],
  catalog: null,
};

/** For `state/plugins`: core's list has arrived, holding the fixture plugin while it is on. */
export const pluginsModule = {
  pluginsLoaded: () => true,
  plugins: () => (on() ? [{ id: UNLOCKER, bundled: true, status: 'active' }] : []),
  pluginActive: (id: string) => id === UNLOCKER && on(),
};
