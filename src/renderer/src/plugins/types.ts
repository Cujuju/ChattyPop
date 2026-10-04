// Plugin panel contract (API 1.1), renderer side. The core-side API is in src/shared/plugins.ts.

/** What a plugin panel gets (API 1.1). It renders into a plain element with whatever it bundles; no host framework is shared. */
export interface PanelApi {
  readonly pluginId: string;
  /** Calls a function the plugin's core side registered with rpc.handle. */
  call(name: string, ...args: unknown[]): Promise<unknown>;
  /** Opens a message in the Archive. */
  openMessage(channelId: string, messageId: string): void;
  /** Runs when archived messages change (debounced by the host); returns an unsubscribe function. */
  onArchiveChanged(fn: (channelIds: string[]) => void): () => void;
}

/** One panel a plugin's renderer module exports in `panels`. `mount` may return a cleanup function. */
export interface PluginPanel {
  id: string;
  title: string;
  mount(el: HTMLElement, api: PanelApi): void | (() => void);
}
