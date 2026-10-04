// Plugin SDK, main testing (docs/plugin-architecture.md §15): a plugin's main side over a core test harness, for its
// tests. Never bundled into the app: only tests import it (tests/pluginTesting.test.ts).
export { testMainPlugin } from './host';
export type * from './types';
