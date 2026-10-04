// Registries the build generates (bundledPlugins.ts): each lists the included plugins' entries for one process.
declare module 'virtual:bundled-plugins/shared' {
  const entries: readonly import('./bundledTypes').PluginDescriptor[];
  export default entries;
  /** Every plugin folder's anchors when the build leaves some out; null when it includes them all. */
  export const catalog: import('./bundledCheck').AnchorCatalog | null;
}

// The installed plugins main's start accepted (docs/plugin-architecture.md §16): their descriptors, in id order.
declare module 'virtual:installed-plugins/shared' {
  const entries: readonly import('./bundledTypes').PluginDescriptor[];
  export default entries;
}
