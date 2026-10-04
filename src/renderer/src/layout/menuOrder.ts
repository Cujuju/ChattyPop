// Optional panels precede preset panels without disturbing either group's declared order.
/** A panel is optional exactly when none of the build's presets contains it. */
export function optionalPanelsFirst<T extends string>(order: readonly T[], inPresets: ReadonlySet<string>): T[] {
  return [...order.filter((id) => !inPresets.has(id)), ...order.filter((id) => inPresets.has(id))];
}
