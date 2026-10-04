// Host shortcuts, every one behind the leader key: press the leader, then one key (leaderRules.ts), bound per
// shortcutBindings.ts to its declared key or the owner's override (Settings → Desktop).
import { createSignal, onCleanup } from 'solid-js';
import { SETTINGS_KEYS } from '@shared/settings';
import { bundledShortcuts } from '@shared/bundledPlugins';
import { createSetting } from '@plugin-sdk/renderer/settings';
import { PRESETS, type PresetId } from '@/layout/presets';
import { shortcutAction, withPluginShortcuts, type ShortcutHint } from '@/plugins/slots';
import { isInEscapeOwner, isInOverlay, isTypingTarget, spacePresses } from '@/ui/keys';
import { listen } from '@/ui/listen';
import { showArchive, showLive } from './archive';
import { showPreviousChannel } from './channelRecents';
import { chatSource } from './chat';
import { setLayoutId } from './layout';
import { DEFAULT_LEADER_KEY, LEADER_TIMEOUT_MS, escapeBlursField, keyLabel, leaderStep, normalizeLeaderKey } from './leaderRules';
import {
  LAYOUT_HINT,
  LAYOUT_KEYS,
  effectiveBindings,
  normalizeBindingOverrides,
  pluginShortcutId,
  shortcutDefs,
  shortcutTarget,
  type Binding,
  type BindingOverrides,
  type RebindableHostId,
} from './shortcutBindings';
import { reactionPicker } from './reactions';
import { focusSearch } from './search';
import { contextMenu, lightbox, setSwitcherOpen, settingsOpen } from './ui';

/** The key pressed before every shortcut (Settings → Desktop). */
export const [leaderKey, setLeaderKey] = createSetting(SETTINGS_KEYS.leaderKey, DEFAULT_LEADER_KEY, normalizeLeaderKey);
/** The owner's shortcut keys, by shortcut id (Settings → Desktop); the rest keep their declared keys. */
export const [bindingOverrides, setBindingOverrides] = createSetting<BindingOverrides>(SETTINGS_KEYS.shortcutBindings, {}, normalizeBindingOverrides);

/** Every shortcut the build declares, the host's then plugins' (on or off), so a plugin turned on finds its key free. */
export const SHORTCUT_DEFS = shortcutDefs(bundledShortcuts());
/** Every shortcut with its effective key. Reactive. */
export const bindings = (): Binding[] => effectiveBindings(SHORTCUT_DEFS, bindingOverrides(), leaderKey());

const [leaderArmed, setLeaderArmed] = createSignal(false);
/** The leader was pressed and waits for a shortcut's key (the status bar marks it). */
export { leaderArmed };

/** Layout digits pick presets in the top bar's order. */
const PRESET_IDS = Object.keys(PRESETS) as PresetId[];

/** What each single-key host shortcut does. */
const HOST_ACTIONS: Readonly<Record<RebindableHostId, () => void>> = {
  live: () => (chatSource() === 'live' ? showArchive() : showLive()),
  search: focusSearch,
  switcher: () => setSwitcherOpen(true),
  back: showPreviousChannel,
};

/** Typing in a field, focus in a window or menu, or Settings, the lightbox or a menu being open: keys belong there. */
function blocked(e: KeyboardEvent): boolean {
  return isTypingTarget(e.target) || isInOverlay(e.target) || settingsOpen() || lightbox() !== null || contextMenu() !== null;
}

/** Escape belongs to an open window, menu or picker: the field's, or the context menu, lightbox or reaction picker. */
function escapeOwned(e: KeyboardEvent): boolean {
  return isInEscapeOwner(e.target) || lightbox() !== null || contextMenu() !== null || reactionPicker() !== null;
}

let disarmTimer: ReturnType<typeof setTimeout> | undefined;
function disarm(): void {
  clearTimeout(disarmTimer);
  setLeaderArmed(false);
}

/** Runs shortcuts from this window's key presses until the calling owner is disposed. The main window only (App). */
export function listenForShortcuts(): void {
  onCleanup(disarm);
  listen(window, 'keydown', onKeyDown);
}

/** Runs the shortcut `key` is bound to; a plugin's only while it is on. */
function runShortcut(key: string): void {
  const target = shortcutTarget(key, bindings());
  if (target?.kind === 'layout') {
    const id = PRESET_IDS[target.index];
    if (id) setLayoutId(id);
  } else if (target?.kind === 'host') HOST_ACTIONS[target.id]();
  else if (target?.kind === 'plugin') shortcutAction(target.pluginId, target.key)?.();
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.defaultPrevented) return;
  if (escapeBlursField(e, { inField: isTypingTarget(e.target), escapeOwned: escapeOwned(e) })) {
    e.preventDefault();
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    return;
  }
  const step = leaderStep(leaderArmed(), e, { leaderKey: leaderKey(), blocked: blocked(e), spacePresses: spacePresses(e.target) });
  if (step.kind === 'pass') return;
  if (step.kind === 'arm') {
    e.preventDefault();
    setLeaderArmed(true);
    clearTimeout(disarmTimer);
    disarmTimer = setTimeout(disarm, LEADER_TIMEOUT_MS);
    return;
  }
  disarm();
  if (step.kind === 'disarm') {
    if (step.consume) e.preventDefault();
    return;
  }
  e.preventDefault();
  runShortcut(step.key);
}

/** Every shortcut's hint, host and plugin, for the status bar, with its effective key. Reactive. */
export function shortcutHints(): ShortcutHint[] {
  const current = bindings();
  const labelOf = (id: string): string => keyLabel(current.find((b) => b.id === id)?.key ?? '');
  const host: ShortcutHint[] = [
    { id: 'layout', keys: `${LAYOUT_KEYS[0]}-${PRESET_IDS.length}`, hint: LAYOUT_HINT },
    ...current.filter((b) => !b.plugin).map((b) => ({ id: b.id, keys: keyLabel(b.key), hint: b.hint })),
  ];
  return withPluginShortcuts(host, (pluginId, key) => labelOf(pluginShortcutId(pluginId, key)));
}
