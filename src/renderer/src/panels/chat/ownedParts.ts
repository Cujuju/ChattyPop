// Plugin-owned parts of a message (chips, attachment notes, annotations) show only while their owner can present them.

/** Parts without an owner, and those whose owner `presents`; reactive when `presents` is. Any snapshot age. */
export const presentedParts = <T extends { pluginId?: string }>(parts: readonly T[], presents: (pluginId: string) => boolean): T[] =>
  parts.filter((p) => p.pluginId === undefined || presents(p.pluginId));
