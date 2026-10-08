// Renderer UI state, windows and context menus.
import { api } from '@/api';
import type { MenuGroup } from '../ui/menuTypes';
export type { MenuItem, MenuGroup, MenuRun } from '../ui/menuTypes';
export type { IconName } from '../ui/iconNames';
import { createSignal } from 'solid-js';
import type { ArchiveMessage } from '@shared/contract';
import type { LayoutPanelId } from '@/layout/types';
import { bundledPanels } from '@shared/bundledPlugins';
import { raiseWindow } from './windows';
import { createSetting } from '@plugin-sdk/renderer/settings';
import { SETTINGS_KEYS } from '@shared/settings';
import { recordOf, textOrNull } from '@shared/normalize';

/** The panel this window shows on its own (a panel window), or null in the main window. */
export const PANEL_WINDOW_ID: string | null = new URLSearchParams(location.search).get('panel');
export const inPanelWindow = PANEL_WINDOW_ID !== null;
/** The phone companion (the companion plugin's page marks its root): one panel at a time over the network, no layout. */
export const inCompanion = document.documentElement.dataset['surface'] === 'companion';
/** Panels shown outside the main window's layout (a panel window or the phone): no folding, moving or layout menus. */
export const outsideLayout = inPanelWindow || inCompanion;
/** Opens a panel in its own window (or focuses it). */
export const openPanelWindow = (id: string): void => void api.openPanelWindow(id);

/** Panels the top bar opens in an in-app window, like Settings, instead of their own app window: bundled ones that ask to. */
export const DIALOG_PANELS: readonly string[] = bundledPanels().filter((p) => p.dialog).map((p) => p.id);
export const isDialogPanel = (id: string): boolean => DIALOG_PANELS.includes(id);
/** In-app panel windows that are open. */
export const [panelDialogs, setPanelDialogs] = createSignal<readonly string[]>([]);
/** Its FloatingWindow id: the key its geometry is saved under. */
export const panelDialogWindowId = (id: string): string => `panel:${id}`;
/** Opens panel `id`'s in-app window, or brings it to the front. */
export function openPanelDialog(id: string): void {
  if (panelDialogs().includes(id)) raiseWindow(panelDialogWindowId(id));
  else setPanelDialogs([...panelDialogs(), id]);
}
export const closePanelDialog = (id: string): void => void setPanelDialogs(panelDialogs().filter((d) => d !== id));

/** Whether the Settings dialog is open. Overlays hide the native Discord view, which always paints on top. */
export const [settingsOpen, setSettingsOpen] = createSignal(false);
/** Settings' open tab id, restored on start (null: the first tab). */
export const [settingsTab, setSettingsTab] = createSetting<string | null>(SETTINGS_KEYS.settingsTab, null, (v) => textOrNull(v));
/** Each Settings page's open section id, by page id, restored on start. */
export const [settingsSections, setSettingsSections] = createSetting<Record<string, string>>(
  SETTINGS_KEYS.settingsSections,
  {},
  recordOf((v): v is string => typeof v === 'string'),
);
/** A Settings section to show next (its tab id); the dialog consumes it. */
export const [settingsSection, setSettingsSection] = createSignal<string | null>(null);
/** Opens Settings at one section. */
export function openSettingsAt(section: string): void {
  setSettingsSection(section);
  setSettingsOpen(true);
}

/** Whether the channel switcher (views/switcher) is open. */
export const [switcherOpen, setSwitcherOpen] = createSignal(false);

/** Split dragging hides native Discord to preserve pointer access. */
export const [resizing, setResizing] = createSignal(false);

/** Panel dragging hides native Discord to expose drop zones. */
export const [draggedPanel, setDraggedPanel] = createSignal<LayoutPanelId | null>(null);

/** An image opened in the viewer: the full-size source, a label, and the original to open in the browser. */
export interface LightboxImage {
  src: string;
  /** An animated image's still, shown while the owner can't look. */
  still?: string;
  alt: string;
  caption: string;
  /** Discord's original URL, for "Open original". */
  originalUrl: string | null;
}
export const [lightbox, setLightbox] = createSignal<LightboxImage | null>(null);

/** The message a Jev check is open for. */
export const [jevCheckFor, setJevCheckFor] = createSignal<ArchiveMessage | null>(null);
/** The channel an "Ask Jev" run is open for (custom Jev call over its latest messages). */
export const [jevAskChannel, setJevAskChannel] = createSignal<string | null>(null);

export interface ContextMenuState {
  x: number;
  y: number;
  /** Non-empty groups only. */
  groups: MenuGroup[];
  /** A message's menu: its quick reactions lead it. */
  reactTo?: ArchiveMessage;
  /** A message's menu: the id of the message, whose row stays highlighted while it is open. */
  messageId?: string;
  /** A menu below its anchor: the anchor's top, which the menu ends at instead when no room is below. */
  flipY?: number;
}
/** The open right-click menu, at viewport coordinates. */
export const [contextMenu, setContextMenu] = createSignal<ContextMenuState | null>(null);

/** Opens `groups` as the right-click menu at the pointer, in place of the browser's; empty groups are dropped, and nothing opens when all are. */
export function openContextMenu(e: MouseEvent, groups: MenuGroup[], opts: Pick<ContextMenuState, 'reactTo' | 'messageId'> = {}): void {
  const shown = groups.filter((g) => g.items.length > 0);
  if (!shown.length) return;
  e.preventDefault();
  setContextMenu({ x: e.clientX, y: e.clientY, groups: shown, ...opts });
}

/** Opens `groups` as a menu at `anchor`: under it (a bar's button; above when no room is below), or beside it (a flyout from a row's menu). */
export function openMenuAt(anchor: Element, groups: MenuGroup[], side: 'below' | 'beside' = 'below'): void {
  const shown = groups.filter((g) => g.items.length > 0);
  if (!shown.length) return;
  const r = anchor.getBoundingClientRect();
  setContextMenu(side === 'below' ? { x: r.left, y: r.bottom, flipY: r.top, groups: shown } : { x: r.right, y: r.top, groups: shown });
}
