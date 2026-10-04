// The posting lock for renderer state tests: stand-ins for the plugin list and the bundled descriptors state/posting reads,
// with one fixture plugin declaring `unlocks: { posting: true }`. Mock both modules from these, then flip the lock.
import { createRequire } from 'node:module';

// The client runtime, as the tests that use this mock solid-js to.
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
