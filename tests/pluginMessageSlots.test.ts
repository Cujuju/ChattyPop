// Active plugin message items interleave with host slots; posting plugins fill empty host posting anchors.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type { ArchiveMessage } from '@shared/contract';
import { HOST_CHAT_FOOTER_ITEMS, HOST_HOVER_ACTIONS, HOST_HOVER_EMOJI_ITEMS } from '@shared/anchors';
import { anchorCatalog, catalogSlotAnchor } from '@shared/bundledCheck';
import { definePlugin, type PluginDescriptor, type SlotDecls } from '@plugin-sdk/shared';
import { readSlots, type ReadSlotEntry } from '../src/renderer/src/plugins/readSlots';

// Uses Solid’s browser runtime so reactive state runs as in a window.
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);

const SELF = 'me';
const menus = vi.hoisted(() => [] as { label: string }[][][]);
const savedMenu = vi.hoisted(() => ({ items: [] as { label: string }[] }));
const localSpoilers = vi.hoisted(() => new Set<string>());
vi.mock('../src/renderer/src/state/localSpoilers', () => ({
  isLocalSpoiler: (key: string) => localSpoilers.has(key),
  setLocalSpoiler: async (key: string, marked: boolean) => { if (marked) localSpoilers.add(key); else localSpoilers.delete(key); },
}));
/** Places menu groups according to renderer slots; each test sets the groups. */
const placeMenu = vi.hoisted(() => ({
  groups: (_m: unknown, _scope: unknown, host: unknown): unknown => host,
  attachments: (_m: unknown, _a: unknown, _host: unknown): unknown => [],
}));
vi.mock('@/api', () => ({ api: {} }));
vi.mock('@/plugins/slots', () => ({
  messageMenuGroups: (m: unknown, scope: unknown, host: unknown) => placeMenu.groups(m, scope, host),
  attachmentMenuItems: (m: unknown, a: unknown, host: unknown) => placeMenu.attachments(m, a, host),
}));
vi.mock('../src/renderer/src/state/savedFiles', () => ({ canSave: (a: { status: string }) => a.status === 'stored', saveAttachment: () => Promise.resolve() }));
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

vi.mock('../src/renderer/src/state/savedMessages', () => ({ savedMenuItems: () => savedMenu.items, prepareSavedMenu: () => undefined }));

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
  /** The last menu's groups. */
  const lastMenu = () => menus.at(-1)! as unknown as { label: string; checked?: boolean; run?(): void; submenu?: { items: { label: string; checked?: boolean; run(): void }[] }[] }[][];
  /** `attachmentId`: the menu opens on that attachment's tile (holding `player`, if any), else on the message's text. */
  const menuOf = (m: ArchiveMessage, entries: readonly ReadSlotEntry[], attachmentId?: string, player: object | null = null, part?: { localSpoilerKey: string; senderSpoiler?: string }): string[][] => {
    const slots = readSlots(() => entries, () => true, () => true, catalogSlotAnchor(anchorCatalog(entries.map((e) => e.plugin))));
    placeMenu.groups = slots.messages as typeof placeMenu.groups;
    placeMenu.attachments = slots.attachments as typeof placeMenu.attachments;
    const Element = class {};
    vi.stubGlobal('window', { getSelection: () => null });
    vi.stubGlobal('Element', Element);
    const tile = { dataset: { attachmentId }, querySelector: (s: string) => (s === 'audio, video' ? player : null) };
    const target = Object.assign(new Element(), { closest: (s: string) => (s === '[data-attachment-id]' && attachmentId ? tile : s === '[data-local-spoiler-key]' && part ? { dataset: part } : null) });
    openMessageMenu({ target }, m);
    vi.unstubAllGlobals();
    return menus.at(-1)!.map((items) => items.map((i) => i.label));
  };
  const item = (label: string) => ({ label, icon: 'text' as const, run: () => undefined });
  /** A posting plugin declaring what discord-client declares: Reply/Forward before `saved`, Delete after `delete`. */
  const poster = definePlugin({
    manifest: { id: 'poster', name: 'poster', version: '1', description: '' },
    slots: {
      hoverActions: [{ id: 'edit', before: 'edit' }, { id: 'reply', before: 'reply' }, { id: 'forward', before: 'forward' }],
      messageMenu: [{ id: 'lead', before: 'saved' }, { id: 'delete', after: 'delete' }],
    },
  });

  it('are absent without a plugin: the bar draws nothing between its reactions and More, the menu offers none', () => {
    const placed = slotsOf([], () => true).hoverActions(HOST_HOVER_ACTION_ANCHORS);
    expect(ids(placed)).toEqual(['edit', 'reply', 'forward']);
    expect(placed.map((a) => a.Component({ message: message() }))).toEqual([null, null, null]);
    expect(menuOf(message(), [])).toEqual([['View conversation', 'View A'], ['Text', 'Message link', 'Message ID']]);
  });

  it("put a pressed attachment's Download, then Edit and Delete at their anchors, after what was pressed", () => {
    const attachments = [{ id: 'a1', status: 'stored', sha256: 'h' }, { id: 'a2', status: 'pending', sha256: null }];
    const m = message({ attachments } as unknown as Partial<ArchiveMessage>);
    const changer = definePlugin({
      manifest: { id: 'poster', name: 'poster', version: '1', description: '' },
      slots: { attachmentMenu: [{ id: 'modify', before: 'modify' }, { id: 'delete', before: 'delete' }] },
    });
    const menu: ReadSlotEntry = {
      plugin: changer,
      contributions: { attachmentMenu: { modify: { calls: [], item: () => item('Edit attachment') }, delete: { calls: [], item: () => item('Delete attachment') } } },
    };
    const views = ['View conversation', 'View A'];
    const copies = ['Text', 'Message link', 'Message ID'];
    expect(menuOf(m, [menu], 'a1')).toEqual([['Download', 'Edit attachment', 'Mark as spoiler locally', 'Delete attachment'], views, copies]);
    // Not held here: no Download.
    expect(menuOf(m, [menu], 'a2')).toEqual([['Edit attachment', 'Mark as spoiler locally', 'Delete attachment'], views, copies]);
    // Pressed elsewhere: no attachment's items.
    expect(menuOf(m, [menu])).toEqual([views, copies]);
  });

  it("put a playing attachment's speed first, its choices Chromium's, the current one checked, a choice applying to that player", () => {
    const m = message({ attachments: [{ id: 'a1', status: 'stored', sha256: 'h' }] } as unknown as Partial<ArchiveMessage>);
    const player = { playbackRate: 1.5 };
    expect(menuOf(m, [], 'a1', player)[0]).toEqual(['Playback speed', 'Download', 'Mark as spoiler locally']);
    const speeds = lastMenu()[0]![0]!.submenu![0]!.items;
    expect(speeds.map((s) => s.label)).toEqual(['0.25×', '0.5×', '0.75×', 'Normal', '1.25×', '1.5×', '1.75×', '2×']);
    expect(speeds.filter((s) => s.checked).map((s) => s.label)).toEqual(['1.5×']);
    speeds.find((s) => s.label === 'Normal')!.run();
    expect(player.playbackRate).toBe(1);
  });

  it('marks only the pressed attachment and offers removal, while sender spoilers retain their own state', async () => {
    localSpoilers.clear();
    const m = message({ attachments: [{ id: 'a1', spoiler: false }, { id: 'a2', spoiler: true }] } as unknown as Partial<ArchiveMessage>);
    expect(menuOf(m, [], 'a1')[0]).toEqual(['Mark as spoiler locally']);
    await lastMenu()[0]![0]!.run!();
    expect(menuOf(m, [], 'a1')[0]).toEqual(['Remove local spoiler']);
    expect(menuOf(m, [], 'a2')[0]).toEqual(['Mark as spoiler locally']);
    await lastMenu()[0]![0]!.run!();
    expect(menuOf(m, [], 'a2')[0]).toEqual(['Remove local spoiler']);
    await lastMenu()[0]![0]!.run!();
    menuOf(m, [], 'a1');
    await lastMenu()[0]![0]!.run!();
    expect(localSpoilers.size).toBe(0);
    expect(m.attachments[0]!.spoiler).toBe(false);
    expect(m.attachments[1]!.spoiler).toBe(true);
  });

  it('adds a local action for the pressed link or preview, including sender spoilers, with none on plain text', async () => {
    localSpoilers.clear();
    const m = message();
    const part = { localSpoilerKey: 'link:m:one' };
    expect(menuOf(m, [], undefined, null, part)[0]).toEqual(['Mark as spoiler locally']);
    await lastMenu()[0]![0]!.run!();
    expect(menuOf(m, [], undefined, null, part)[0]).toEqual(['Remove local spoiler']);
    expect(menuOf(m, []).flat()).not.toContain('Remove local spoiler');
    expect(menuOf(m, [], undefined, null, { localSpoilerKey: 'link:m:two', senderSpoiler: 'true' })[0]).toEqual(['Mark as spoiler locally']);
    localSpoilers.clear();
  });

  it("land at the host's anchors: Edit, Reply, Forward on the bar; Reply, Forward before bookmarks and reminders, Delete last", () => {
    const bar = slotsOf([entry('poster', poster.slots!, { hoverActions: { edit: view, reply: view, forward: view } })], () => true);
    expect(ids(bar.hoverActions(HOST_HOVER_ACTION_ANCHORS))).toEqual(['poster.edit', 'edit', 'poster.reply', 'reply', 'poster.forward', 'forward']);
    const menu: ReadSlotEntry = {
      plugin: poster,
      contributions: {
        messageMenu: { lead: { calls: [], menu: () => [item('Edit'), item('Reply'), item('Forward')] }, delete: { calls: [], menu: () => [item('Delete')] } },
      },
    };
    savedMenu.items = [item('Bookmarks and reminders')];
    expect(menuOf(message(), [menu])).toEqual([['Edit', 'Reply', 'Forward'], ['Bookmarks and reminders'], ['View conversation', 'View A'], ['Text', 'Message link', 'Message ID'], ['Delete']]);
    const withAttachment = message({ attachments: [{ id: 'a1', spoiler: false }] } as unknown as Partial<ArchiveMessage>);
    expect(menuOf(withAttachment, [menu], 'a1')[0]).toEqual(['Mark as spoiler locally']);
    expect(menuOf(withAttachment, [menu], 'a1').at(-1)).toEqual(['Delete']);
    expect(menuOf(message(), [menu], undefined, null, { localSpoilerKey: 'link:m:one' })[0]).toEqual(['Mark as spoiler locally']);
    savedMenu.items = [];
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
