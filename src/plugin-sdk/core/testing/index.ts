// Plugin SDK, core testing (docs/plugin-architecture.md §15): a plugin's core side under the real host, for its tests.
// Never bundled into the app: only tests import it (tests/pluginTesting.test.ts).
export { testPlugin } from './host';
export type * from './types';
