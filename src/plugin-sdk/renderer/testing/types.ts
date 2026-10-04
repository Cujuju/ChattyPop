// The renderer testing harness's public types (docs/plugin-architecture.md §15): SDK types only, so a plugin's tests
// never see a host internal (tests/pluginTesting.test.ts checks the import graph).
import type { WindowAudience } from '@plugin-sdk/renderer';
import type { AppEvent } from '@plugin-sdk/renderer/shell';
import type { CoreLink, MainLink } from '@plugin-sdk/shared/testing';

/** The window a test runs the renderer side in: whose it is, and the harnesses it reaches. */
export interface TestWindowOptions {
  /** A desktop window (`renderer`, the preload's API) or the phone's page (`phone`, its transport's API). */
  audience: WindowAudience;
  /** The core its calls reach (a TestPlugin from @plugin-sdk/core/testing). */
  core: { readonly link: CoreLink };
  /** The main process a desktop window's main calls reach (a TestMainPlugin); unset, they reject. */
  main?: { readonly link: MainLink };
}

/** The window the renderer SDK now runs in. */
export interface TestWindow {
  readonly audience: WindowAudience;
  /** App events this window received so far, as its transport delivered them. */
  received(): AppEvent[];
}

/** Installs the window's API over an in-memory transport; once per test file, since the renderer SDK's state is the window's. */
export type TestWindowFn = (options: TestWindowOptions) => TestWindow;
