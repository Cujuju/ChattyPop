/** The host and plugin contracts reject these Solid binding escapes. */
export const CONTAINMENT_EVASIONS = [
  ["namespace destructuring", "import * as Solid from 'solid-js'; const { batch, onCleanup } = Solid;"],
  ['namespace member call', "import * as Solid from 'solid-js'; Solid.createMemo(() => 1);"],
  ['store namespace', "import * as Store from 'solid-js/store'; Store.createStore({});"],
  ['require', "const { createMemo } = require('solid-js');"],
  ['store require', "const Store = require('solid-js/store');"],
  ['dynamic import', "const Solid = import('solid-js');"],
  ['store dynamic import', "const Store = import('solid-js/store');"],
  ['template dynamic import', 'const Solid = import(`solid-js`);'],
  ['local computation alias', "import { createMemo } from 'solid-js'; const memo = createMemo; memo(() => 1);"],
  ['passed computation', "import { createMemo } from 'solid-js'; factory(createMemo);"],
  ['destructured computation', "import { createMemo } from 'solid-js'; const { memo } = { memo: createMemo };"],
  ['computation member call', "import { createMemo } from 'solid-js'; createMemo.call(null, () => 1);"],
  ['forbidden binding alias', "import { batch } from 'solid-js'; const run = batch;"],
  ['passed forbidden binding', "import { onCleanup } from 'solid-js'; factory(onCleanup);"],
  ['store binding alias', "import { createStore } from 'solid-js/store'; const store = createStore;"],
  ['re-exported computation', "export { createMemo as memo } from 'solid-js';"],
] as const;
