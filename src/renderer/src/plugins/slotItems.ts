// Plugin items in one host slot, as the slot shows them: declared in descriptors, stamped by the host, placed by the catalog.
import { placeByAnchor, type PlacementAnchor } from '@shared/anchors';
import type { PluginDescriptor } from '@shared/bundledTypes';
import { slotId, type SlotKind } from '@shared/slots';

/** A slot item as its slot shows it: its id (a host item's, or a plugin item's stamped id) with its view. */
export type SlotItem<V> = V & { id: string };

/** Where a plugin's slot item goes, by stamped id: the build's catalog (bundledPlugins slotAnchor), so absent owners still anchor. */
export type SlotAnchorOf = (kind: SlotKind, id: string) => PlacementAnchor | undefined;

/** Each view's item by stamped id, so a slot's reactive reads return the same objects and keyed lists keep their DOM. */
const items = new WeakMap<object, Map<string, object>>();

/** `view` with stamped `id`, the same object on every read. */
function itemOf<V extends object>(view: V, id: string): SlotItem<V> {
  const byId = items.get(view) ?? new Map<string, object>();
  items.set(view, byId);
  const known = byId.get(id) as SlotItem<V> | undefined;
  if (known) return known;
  const item = { ...view, id };
  byId.set(id, item);
  return item;
}

/** `entries`' items declared in slot `kind`, in build then declaration order, each with its view and stamped id. */
export function declaredItems<E extends { plugin: PluginDescriptor }, V extends object>(
  entries: readonly E[],
  kind: SlotKind,
  views: (entry: E) => Readonly<Record<string, V>> | undefined,
): SlotItem<V>[] {
  return entries.flatMap((entry) =>
    (entry.plugin.slots?.[kind] ?? []).flatMap((decl) => {
      const view = views(entry)?.[decl.id];
      return view ? [itemOf(view, slotId(entry.plugin.manifest.id, decl.id))] : [];
    }),
  );
}

/** `host` items with `extra` plugin items placed among them by the catalog's anchors. */
export const placeSlot = <T extends { id: string }>(kind: SlotKind, host: readonly T[], extra: readonly T[], anchorOf: SlotAnchorOf): T[] =>
  placeByAnchor<T>(host, extra, (item) => item.id, (id) => anchorOf(kind, id));
