// The build's main registry of bundled plugins (bundledPlugins.ts), then the installed plugins main's start accepted.
declare module 'virtual:bundled-plugins/main' {
  const entries: readonly import('./context').MainPlugin[];
  export default entries;
  /** Accepted installed plugins whose node modules failed to load in this process. */
  export const failed: readonly import('@shared/installedCheck').InstalledFailure[];
}

// Export names of the node host modules main's boot can't load before the registry (bundledPlugins.ts), by module id.
declare module 'virtual:installed-plugins/host-exports' {
  const names: Readonly<Record<string, readonly string[]>>;
  export default names;
}
