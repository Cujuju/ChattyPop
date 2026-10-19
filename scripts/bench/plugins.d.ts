declare module 'write-bench-plugins' {
  export const attachments: import('../../src/core/plugins/context').CorePlugin;
  export const links: import('../../src/core/plugins/context').CorePlugin;
  export const stats: import('../../src/core/plugins/context').CorePlugin;
  export const CHANNEL: string;
  export function seed(db: import('../../src/core/plugins/pluginDb').PluginDb, rows: number): object;
}
