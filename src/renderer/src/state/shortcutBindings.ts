// Pure shortcut overrides resolve owner or declared keys; state/shortcuts.ts wires bindings.
import { HOST_SHORTCUTS, type HostShortcutId } from '@shared/anchors';
import { stampedName } from '@shared/bundledTypes';
import { recordOf } from '@shared/normalize';
import { MODIFIER_KEYS, isLeaderKey, keyLabel } from './leaderRules';

/** Host shortcuts bound to one key each. Layout is a digit group, fixed: its digits pick presets by position. */
export type RebindableHostId = Exclude<HostShortcutId, 'layout'>;
/** Keys the layout group takes; no other shortcut may use them. */
export const LAYOUT_KEYS: readonly string[] = HOST_SHORTCUTS.layout;
/** The layout group's status-bar hint. */
export const LAYOUT_HINT = 'layout';

/** A status-bar hint as a Settings name: its first letter raised. */
const sentenceCase = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
/** The layout group's name in Settings. */
export const LAYOUT_NAME = sentenceCase(LAYOUT_HINT);

const HOST_HINTS: Readonly<Record<RebindableHostId, string>> = {
  live: 'live/archive',
  search: 'search',
  switcher: 'switch channel',
  back: 'previous channel',
};

/** A shortcut with one key: a host one, or one a plugin declares. */
export interface ShortcutDef {
  /** A host id, or `<plugin id>.<declared key>` (pluginShortcutId). */
  id: string;
  /** The status bar's hint; shortcuts of a hint group share one. */
  hint: string;
  /** What this one key does, as Settings and refusals name it. */
  name: string;
  /** Its declared key; null follows the leader (the switcher: the leader pressed twice). */
  defaultKey: string | null;
  /** A plugin's shortcut: its plugin and the key its descriptor declares (the key its action is under). */
  plugin?: { id: string; key: string };
}

/** A shortcut with its effective key. */
export interface Binding extends ShortcutDef {
  key: string;
  /** The key is the leader because the shortcut follows it, not by an override. */
  followsLeader: boolean;
}

/** A plugin shortcut's id: stable across plugin reloads, whatever key it is bound to. */
export const pluginShortcutId = (pluginId: string, key: string): string => stampedName(pluginId, key);

/** Host shortcuts in the status bar's order, after the layout group. HOST_SHORTCUTS.switcher is empty: it follows the leader. */
export const HOST_SHORTCUT_DEFS: readonly ShortcutDef[] = (Object.keys(HOST_HINTS) as RebindableHostId[]).map((id) => ({
  id,
  hint: HOST_HINTS[id],
  name: sentenceCase(HOST_HINTS[id]),
  defaultKey: (HOST_SHORTCUTS[id] as readonly string[])[0] ?? null,
}));

/** Every shortcut's def: the host's, then each plugin declaration's in build order. A plugin's name defaults to its hint. */
export const shortcutDefs = (plugins: readonly { pluginId: string; key: string; hint: string; name?: string }[]): ShortcutDef[] => [
  ...HOST_SHORTCUT_DEFS,
  ...plugins.map((s) => ({
    id: pluginShortcutId(s.pluginId, s.key),
    hint: s.hint,
    name: sentenceCase(s.name ?? s.hint),
    defaultKey: s.key,
    plugin: { id: s.pluginId, key: s.key },
  })),
];

/** Escape disarms the leader and cancels a key capture, so it runs no shortcut. */
const ESCAPE = 'Escape';
/** Whether `key` (a KeyboardEvent key) can be a shortcut's key at all: no lone modifier, not Escape. */
export const isBindableKey = (key: string): boolean => key.length > 0 && key !== ESCAPE && !MODIFIER_KEYS.has(key);

/** Stored overrides, by shortcut id. Ids of shortcuts not loaded are kept, so a plugin's override outlives its absence. */
export type BindingOverrides = Record<string, string>;
export const normalizeBindingOverrides: (v: unknown) => BindingOverrides = recordOf((v): v is string => typeof v === 'string' && isBindableKey(v));

/** Each def's effective key: its override, else its declared key, else the leader. Overrides for no def are ignored. */
export function effectiveBindings(defs: readonly ShortcutDef[], overrides: BindingOverrides, leader: string): Binding[] {
  return defs.map((d) => {
    const override = overrides[d.id];
    if (override !== undefined) return { ...d, key: override, followsLeader: false };
    return { ...d, key: d.defaultKey ?? leader, followsLeader: d.defaultKey === null };
  });
}

/** What `key` runs after the leader: a layout by position, a host shortcut, a plugin's (by its declared key), or nothing. */
export type ShortcutTarget =
  | { kind: 'layout'; index: number }
  | { kind: 'host'; id: RebindableHostId }
  | { kind: 'plugin'; pluginId: string; key: string }
  | null;

/** The dispatcher's lookup: layout digits, else the first binding with `key` (host before plugins). */
export function shortcutTarget(key: string, bindings: readonly Binding[]): ShortcutTarget {
  if (LAYOUT_KEYS.includes(key)) return { kind: 'layout', index: LAYOUT_KEYS.indexOf(key) };
  const b = bindings.find((o) => o.key === key);
  if (!b) return null;
  return b.plugin ? { kind: 'plugin', pluginId: b.plugin.id, key: b.plugin.key } : { kind: 'host', id: b.id as RebindableHostId };
}

const taken = (b: Binding): string => `“${b.name}” uses ${keyLabel(b.key)}`;

/** Why shortcut `id` can't take `key`, or null when it can. A shortcut that follows the leader may take it back. */
export function rebindRefusal(id: string, key: string, bindings: readonly Binding[], leader: string): string | null {
  const own = bindings.find((b) => b.id === id);
  if (!own) return 'That shortcut isn’t loaded.';
  if (!isBindableKey(key)) return 'Press a key other than Escape, Shift, Ctrl, Alt or Win.';
  if (LAYOUT_KEYS.includes(key)) return `${LAYOUT_KEYS[0]}–${LAYOUT_KEYS.at(-1)} pick layouts.`;
  if (key === leader && own.defaultKey !== null) return `${keyLabel(key)} is the leader key.`;
  const other = bindings.find((b) => b.id !== id && b.key === key);
  return other ? `${taken(other)}.` : null;
}

/** Why `key` can't be the leader, or null when it can: Space or a symbol no shortcut takes on its own. */
export function leaderRefusal(key: string, bindings: readonly Binding[]): string | null {
  if (!isLeaderKey(key)) return 'The leader is Space or a symbol key.';
  const other = bindings.find((b) => !b.followsLeader && b.key === key);
  return other ? `${taken(other)}.` : null;
}

/** Overrides with shortcut `def` bound to `key`; null, its declared key or (following it) the leader drop the override. */
export function withBinding(overrides: BindingOverrides, def: ShortcutDef, key: string | null, leader: string): BindingOverrides {
  const next = { ...overrides };
  if (key === null || key === (def.defaultKey ?? leader)) delete next[def.id];
  else next[def.id] = key;
  return next;
}

/** Lists bindings shadowed by earlier keys, including newly installed plugin defaults. */
export function shadowedBindings(bindings: readonly Binding[]): Map<string, Binding> {
  const shadowed = new Map<string, Binding>();
  bindings.forEach((b, i) => {
    const first = bindings.findIndex((o) => o.key === b.key);
    if (first < i) shadowed.set(b.id, bindings[first]!);
  });
  return shadowed;
}
