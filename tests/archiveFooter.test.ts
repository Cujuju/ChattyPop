// Archive footer omits the host composer, mounts typing state, and renders plugin footer items.
import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOST_CHAT_FOOTER_ITEMS } from '@shared/anchors';
import { anchorCatalog, catalogSlotAnchor } from '@shared/bundledCheck';
import { definePlugin, type PluginDescriptor } from '@plugin-sdk/shared';
import { ROOT, closure, importsOf } from './rendererGraph';

const HOST_DIR = join(ROOT, 'src/renderer/src');
const ARCHIVE_VIEW = join(HOST_DIR, 'panels/chat/ArchiveView.tsx');
const TYPING_LINE = join(HOST_DIR, 'panels/chat/TypingLine.tsx');
/** The renderer's page entry: what the packaged app loads. */
const MAIN = join(HOST_DIR, 'main.tsx');
/** The message box's modules and styles, which left the host for a posting plugin. */
const MOVED = [
  'Composer', 'ComposerMenus', 'AttachedFiles', 'PickerButtons', 'ReplyBar', 'CommandRow', 'CommandBar', 'CommandMenu', 'CommandPopup',
  'MentionSuggest', 'EmojiSuggest', 'ExpressionPicker', 'GifTab', 'StickerTab', 'SendingPanel', 'textMenus', 'optionSuggestions', 'mentionRows',
  'Composer.module', 'Command.module', 'CommandBar.module', 'SendingPanel.module',
];

type View = { Component: (p: object) => unknown };
type Item = View & { id: string };
type Entry = { plugin: PluginDescriptor; contributions: { chatFooter?: Record<string, View> } };
// Path imports keep DOM types outside node type checking.
const slotsPath = '../src/renderer/src/plugins/messageSlots';
const footerPath = '../src/renderer/src/panels/chat/archiveFooter';
const { messageSlots } = (await import(slotsPath)) as {
  messageSlots(entries: () => readonly Entry[], enabled: (id: string) => boolean, anchorOf: unknown): { chatFooter(host: readonly Item[]): Item[] };
};
const { HOST_FOOTER } = (await import(footerPath)) as { HOST_FOOTER: readonly Item[] };

const footerOf = (entries: readonly Entry[]): Item[] =>
  messageSlots(() => entries, () => true, catalogSlotAnchor(anchorCatalog(entries.map((e) => e.plugin)))).chatFooter(HOST_FOOTER);
const PROPS = { channel: { id: 'c1', name: 'general' }, measure: () => undefined };
const name = (file: string): string => basename(file).replace(/\.(tsx?|css)$/, '');
const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sourceFiles(join(dir, e.name)) : [join(dir, e.name)]));

describe('the Archive footer', () => {
  it('holds, with no plugins, only the composer anchor, which draws no message box', () => {
    const items = footerOf([]);
    expect(items.map((i) => i.id)).toEqual([...HOST_CHAT_FOOTER_ITEMS]);
    expect(items.map((i) => i.Component(PROPS))).toEqual([null]);
  });

  it('mounts who is typing from the view itself, not through the slot, so it shows with or without a plugin', () => {
    expect(importsOf(ARCHIVE_VIEW)).toContain(TYPING_LINE);
  });

  it("renders a fixture plugin's item at its anchor", () => {
    const box = { Component: () => 'probe box' };
    const probe: Entry = {
      plugin: definePlugin({ manifest: { id: 'probe', name: 'Probe', version: '1', description: '' }, slots: { chatFooter: [{ id: 'box', before: 'composer' }] } }),
      contributions: { chatFooter: { box } },
    };
    const items = footerOf([probe]);
    expect(items.map((i) => i.id)).toEqual(['probe.box', 'composer']);
    expect(items.map((i) => i.Component(PROPS))).toEqual(['probe box', null]);
  });
});

describe('the public renderer', () => {
  it('reaches none of the message box from its page entry, and holds none of its files', () => {
    const loaded = [...closure([MAIN])];
    expect(loaded).toContain(TYPING_LINE);
    expect(loaded.filter((f) => MOVED.includes(name(f)))).toEqual([]);
    expect(sourceFiles(HOST_DIR).filter((f) => MOVED.includes(name(f)))).toEqual([]);
  });
});
