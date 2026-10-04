// The build's renderer registry of bundled plugins (bundledPlugins.ts).
declare module 'virtual:bundled-plugins/renderer' {
  const entries: readonly import('./define').RendererPlugin[];
  export default entries;
}
