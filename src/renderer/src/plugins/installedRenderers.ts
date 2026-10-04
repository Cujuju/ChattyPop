// The renderer registry's installed plugins (docs/plugin-architecture.md §16, Start): the build's browser renderer
// registry awaits installedRenderers() (bundledPlugins.ts). It publishes the renderer tiers and Solid, the host
// instances installed plugins' builds read instead of bundling their own.
import * as sdkRenderer from '@plugin-sdk/renderer';
import * as sdkKit from '@plugin-sdk/renderer/kit';
import * as sdkPosting from '@plugin-sdk/renderer/posting';
import * as sdkShell from '@plugin-sdk/renderer/shell';
import * as solid from 'solid-js';
import * as solidStore from 'solid-js/store';
import * as solidWeb from 'solid-js/web';
import type { TierHostModules } from '@shared/installedPlugins';
import type { RendererPlugin } from './define';
import { loadRenderers, windowIo } from './installedLoader';
import { installedShared } from './installedShared';

/** Every browser host module but the shared SDK, which the shared step publishes. */
export const RENDERER_HOST_MODULES = {
  '@plugin-sdk/renderer': sdkRenderer,
  '@plugin-sdk/renderer/kit': sdkKit,
  '@plugin-sdk/renderer/posting': sdkPosting,
  '@plugin-sdk/renderer/shell': sdkShell,
  'solid-js': solid,
  'solid-js/web': solidWeb,
  'solid-js/store': solidStore,
} satisfies TierHostModules<'browser'>;

/** The renderer step, after the shared one: the renderer entries of the installed plugins that loaded, in load order. */
export const installedRenderers = async (): Promise<RendererPlugin[]> => loadRenderers(windowIo(), await installedShared(), RENDERER_HOST_MODULES);
