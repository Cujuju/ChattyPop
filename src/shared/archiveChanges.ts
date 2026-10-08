// A mixed batch must refresh existing rows even when its last write was an insert.
export class ArchiveChanges {
  private readonly channels = new Set<string>();
  private readonly refresh = new Set<string>();

  add(channelId: string, insertOnly: boolean): void {
    this.channels.add(channelId);
    if (!insertOnly) this.refresh.add(channelId);
  }

  take(): { channelIds: string[]; insertOnlyChannelIds: string[] } {
    const channelIds = [...this.channels];
    const insertOnlyChannelIds = channelIds.filter((id) => !this.refresh.has(id));
    this.channels.clear();
    this.refresh.clear();
    return { channelIds, insertOnlyChannelIds };
  }
}
