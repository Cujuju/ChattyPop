// The shared registry's installed plugins (docs/plugin-architecture.md §16, Start): the build's browser shared registry
// awaits installedDescriptors() (bundledPlugins.ts). It loads the shared SDK tier only: a renderer tier reads the shared
// registry, which is still evaluating here (tests/rendererBoundary.test.ts).
import * as sdkShared from '@plugin-sdk/shared';
import type { AnchorCatalog } from '@shared/bundledCheck';
import type { PluginDescriptor } from '@shared/bundledTypes';
import { loadShared, windowIo, type SharedLoaded } from './installedLoader';

let shared: Promise<SharedLoaded[]> | null = null;

/** The shared step, once per page (the shared registry runs it first): the installed plugins kept, in load order. */
export const installedShared = (build: readonly PluginDescriptor[] = [], catalog: AnchorCatalog | null = null): Promise<SharedLoaded[]> =>
  (shared ??= loadShared(windowIo(), sdkShared, build, catalog));

/** Their descriptors, for the shared registry, which passes the build's descriptors and catalog they must validate beside. */
export const installedDescriptors = async (build: readonly PluginDescriptor[], catalog: AnchorCatalog | null): Promise<PluginDescriptor[]> =>
  (await installedShared(build, catalog)).map((p) => p.descriptor);
