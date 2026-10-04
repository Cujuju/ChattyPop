// Contract (plugin-architecture §3, viewer-only-public-host §9, §13): message slots place plugins' items among the host's
// while on. The host's posting anchors are empty; a posting plugin fills them.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type { ArchiveMessage } from '@shared/contract';
import { HOST_CHAT_FOOTER_ITEMS, HOST_HOVER_ACTIONS, HOST_HOVER_EMOJI_ITEMS } from '@shared/anchors';
import { anchorCatalog, catalogSlotAnchor } from '@shared/bundledCheck';
import { definePlugin, type PluginDescriptor, type SlotDecls } from '@plugin-sdk/shared';
import { readSlots, type ReadSlotEntry } from '../src/renderer/src/plugins/readSlots';

// The client runtime, so signals and cleanups run as in a window (node resolves solid-js to its server build).
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);

const SELF = 'me';
const menus = vi.hoisted(() => [] as { label: string }[][][]);
/** Places the menu's groups as the renderer's slots would; each test sets it. */
const placeMenu = vi.hoisted(() => ({ groups: (_m: unknown, _scope: unknown, host: unknown): unknown => host }));
vi.mock('@/api', () => ({ api: {} }));
vi.mock('@/plugins/slots', () => ({ messageMenuGroups: (m: unknown, scope: unknown, host: unknown) => placeMenu.groups(m, scope, host) }));
vi.mock('@/ui/format', () => ({ errorText: String }));
vi.mock('../src/renderer/src/state/channelPolicy', () => ({ channelJevItems: () => [], jevMayRead: () => false }));
vi.mock('../src/renderer/src/state/directory', () => ({ channelById: () => undefined }));
vi.mock('../src/renderer/src/state/conversation', () => ({ openConversation: () => undefined }));
vi.mock('../src/renderer/src/state/person', () => ({ openPerson: () => undefined }));
vi.mock('../src/renderer/src/state/preferences', () => ({ aiSettings: () => ({ jev: { messageCheck: false } }) }));
vi.mock('../src/renderer/src/state/reactions', () => ({ canReact: () => false }));
vi.mock('../src/renderer/src/state/ui', () => ({
  openContextMenu: (_e: unknown, groups: { items: { label: string }[] }[]) => void menus.push(groups.map((g) => g.items)),
  setJevCheckFor: () => undefined,
}));

// Renderer modules: imported by path so the node type-check doesn't follow them (they name DOM types).
const slotsPath = '../src/renderer/src/plugins/messageSlots';
const actionsPath = '../src/renderer/src/state/messageActions';
const tallestPath = '../src/renderer/src/ui/tallestBox';
type Item = { id: string };
type Entry = { plugin: PluginDescriptor; contributions: Record<string, Record<string, object>> };
type Placed = <T extends Item>(host: readonly T[]) => T[];
type HoverItem = Item & { Component(p: { message: ArchiveMessage }): unknown };
const { messageSlots, HOST_HOVER_ACTION_ANCHORS } = (await import(slotsPath)) as {
  messageSlots(entries: () => readonly Entry[], enabled: (id: string) => boolean, anchorOf: unknown): { chatFooter: Placed; hoverEmoji: Placed; hoverActions: Placed };
  HOST_HOVER_ACTION_ANCHORS: readonly HoverItem[];
};
const { openMessageMenu } = (await import(actionsPath)) as { openMessageMenu(e: unknown, m: ArchiveMessage): void };
const { createTallestBox } = (await import(tallestPath)) as { createTallestBox(): { height(): number; observe(el: object): void } };
const { createRoot } = createRequire(import.meta.url)('solid-js/dist/solid.cjs') as typeof import('solid-js');

const view = { Component: () => null };
const host = (ids: readonly string[]): Item[] => ids.map((id) => ({ id, ...view }));
const ids = (items: readonly Item[]) => items.map((i) => i.id);
const entry = (id: string, slots: SlotDecls, contributions: Entry['contributions']): Entry => ({
  plugin: definePlugin({ manifest: { id, name: id, version: '1', description: '' }, slots }),
  contributions,
});
const slotsOf = (entries: readonly Entry[], enabled: (id: string) => boolean) =>
  messageSlots(() => entries, enabled, catalogSlotAnchor(anchorCatalog(entries.map((e) => e.plugin))));

describe('message slots', () => {
  it("hold exactly the host's items, in order, with no plugins; an empty footer holds nothing", () => {
    const none = slotsOf([], () => true);
    expect(ids(none.chatFooter(host(HOST_CHAT_FOOTER_ITEMS)))).toEqual(['composer']);
    expect(ids(none.hoverEmoji(host(HOST_HOVER_EMOJI_ITEMS)))).toEqual(['reactions']);
    expect(ids(none.hoverActions(host(HOST_HOVER_ACTIONS)))).toEqual(['edit', 'reply', 'forward']);
    expect(none.chatFooter([])).toEqual([]);
  });

  it("place a fixture plugin's items at their anchors, and drop them when it is off", () => {
    let on = true;
    const probe = entry(
      'probe',
      { chatFooter: [{ id: 'box', before: 'composer' }], hoverEmoji: [{ id: 'stars' }], hoverActions: [{ id: 'pin', after: 'edit' }, { id: 'quote', before: 'edit' }] },
      { chatFooter: { box: view }, hoverEmoji: { stars: view }, hoverActions: { pin: view, quote: view } },
    );
    const slots = slotsOf([probe], () => on);
    expect(ids(slots.chatFooter(host(HOST_CHAT_FOOTER_ITEMS)))).toEqual(['probe.box', 'composer']);
    expect(ids(slots.hoverEmoji(host(HOST_HOVER_EMOJI_ITEMS)))).toEqual(['reactions', 'probe.stars']);
    expect(ids(slots.hoverActions(host(HOST_HOVER_ACTIONS)))).toEqual(['probe.quote', 'edit', 'probe.pin', 'reply', 'forward']);
    // With no host footer, the plugin's item is the footer.
    expect(ids(slots.chatFooter([]))).toEqual(['probe.box']);
    on = false;
    expect(ids(slots.chatFooter(host(HOST_CHAT_FOOTER_ITEMS)))).toEqual(['composer']);
    expect(ids(slots.hoverEmoji(host(HOST_HOVER_EMOJI_ITEMS)))).toEqual(['reactions']);
    expect(ids(slots.hoverActions(host(HOST_HOVER_ACTIONS)))).toEqual(['edit', 'reply', 'forward']);
    expect(slots.chatFooter([])).toEqual([]);
  });
});

describe('posting actions', () => {
  const message = (more: Partial<ArchiveMessage> = {}) =>
    ({ id: 'm', channelId: 'c', content: 'hi', attachments: [], author: { id: SELF, name: 'A' }, deletedAt: null, prunedAt: null, ...more }) as unknown as ArchiveMessage;
  /** The labels of the menu `m` opens, by group, placed among `entries`' groups. */
  const menuOf = (m: ArchiveMessage, entries: readonly ReadSlotEntry[]): string[][] => {
    placeMenu.groups = readSlots(() => entries, () => true, () => true, catalogSlotAnchor(anchorCatalog(entries.map((e) => e.plugin)))).messages as typeof placeMenu.groups;
    vi.stubGlobal('window', { getSelection: () => null });
    vi.stubGlobal('Element', class {});
    openMessageMenu({ target: { closest: () => null } }, m);
    vi.unstubAllGlobals();
    return menus.at(-1)!.map((items) => items.map((i) => i.label));
  };
  const item = (label: string) => ({ label, icon: 'text' as const, run: () => undefined });
  /** A posting plugin declaring what discord-client declares: each button before its host anchor, Delete after `delete`. */
  const poster = definePlugin({
    manifest: { id: 'poster', name: 'poster', version: '1', description: '' },
    slots: {
      hoverActions: [{ id: 'edit', before: 'edit' }, { id: 'reply', before: 'reply' }, { id: 'forward', before: 'forward' }],
      messageMenu: [{ id: 'lead', before: 'views' }, { id: 'delete', after: 'delete' }],
    },
  });

  it('are absent without a plugin: the bar draws nothing between its reactions and More, the menu offers none', () => {
    const placed = slotsOf([], () => true).hoverActions(HOST_HOVER_ACTION_ANCHORS);
    expect(ids(placed)).toEqual(['edit', 'reply', 'forward']);
    expect(placed.map((a) => a.Component({ message: message() }))).toEqual([null, null, null]);
    expect(menuOf(message(), [])).toEqual([['View conversation', 'View A'], ['Text', 'Message link', 'Message ID']]);
  });

  it("land at the host's anchors in today's order: Edit, Reply, Forward on the bar; Reply, Forward lead the menu, Delete last", () => {
    const bar = slotsOf([entry('poster', poster.slots!, { hoverActions: { edit: view, reply: view, forward: view } })], () => true);
    expect(ids(bar.hoverActions(HOST_HOVER_ACTION_ANCHORS))).toEqual(['poster.edit', 'edit', 'poster.reply', 'reply', 'poster.forward', 'forward']);
    const menu: ReadSlotEntry = {
      plugin: poster,
      contributions: {
        messageMenu: { lead: { calls: [], menu: () => [item('Reply'), item('Forward')] }, delete: { calls: [], menu: () => [item('Delete')] } },
      },
    };
    expect(menuOf(message(), [menu])).toEqual([['Reply', 'Forward'], ['View conversation', 'View A'], ['Text', 'Message link', 'Message ID'], ['Delete']]);
  });
});

describe('footer height', () => {
  it('is the tallest observed box, and zero once none is in the document', () => {
    let report: (entries: object[]) => void = () => undefined;
    const observed = new Set<object>();
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: (entries: object[]) => void) {
        report = cb;
      }
      observe = (el: object) => void observed.add(el);
      unobserve = (el: object) => void observed.delete(el);
      disconnect = () => observed.clear();
    });
    const entryOf = (target: { isConnected: boolean }, px: number) => ({ target, borderBoxSize: [{ blockSize: px }] });
    createRoot((dispose) => {
      const box = createTallestBox();
      expect(box.height()).toBe(0);
      const a = { isConnected: true };
      const b = { isConnected: true };
      box.observe(a);
      box.observe(b);
      report([entryOf(a, 80), entryOf(b, 120)]);
      expect(box.height()).toBe(120);
      b.isConnected = false;
      report([entryOf(b, 0)]);
      expect(box.height()).toBe(80);
      expect(observed.has(b)).toBe(false);
      a.isConnected = false;
      report([entryOf(a, 0)]);
      expect(box.height()).toBe(0);
      dispose();
    });
    vi.unstubAllGlobals();
  });
});
