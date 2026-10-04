// Active main-side label providers, merged without one failing provider suppressing another.
/** Labels for the channel shown in Discord. */
export type LiveLabelProvider = (channelId: string) => Promise<Record<string, string[]>>;
/** Providers retain build order; enablement is read for each refresh. */
export class LiveLabelProviders {
  private readonly providers = new Map<string, LiveLabelProvider>();
  constructor(
    private readonly active: (id: string) => boolean,
    private readonly failed: (id: string, error: unknown) => void,
  ) {}
  /** Registers the plugin's provider. */
  provide(id: string, fn: LiveLabelProvider): void {
    this.providers.set(id, fn);
  }
  /** Reads and merges enabled providers; rejected contributions are omitted. */
  async read(channelId: string): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    for (const [id, fn] of this.providers) {
      if (!this.active(id)) continue;
      try {
        const labels = await fn(channelId);
        if (!this.active(id)) continue;
        for (const [messageId, text] of Object.entries(labels)) out[messageId] = [...(out[messageId] ?? []), ...text];
      } catch (error) {
        if (this.active(id)) this.failed(id, error);
      }
    }
    return out;
  }
}
