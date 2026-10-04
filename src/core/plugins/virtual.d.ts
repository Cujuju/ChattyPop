// The build's core registry of bundled plugins (bundledPlugins.ts), then the installed plugins main's start accepted.
declare module 'virtual:bundled-plugins/core' {
  const entries: readonly import('./context').CorePlugin[];
  export default entries;
  /** Accepted installed plugins whose node modules failed to load in this process. */
  export const failed: readonly import('@shared/installedCheck').InstalledFailure[];
}
