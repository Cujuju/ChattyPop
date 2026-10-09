// Renderer probe contributions are present only while their plugin is active.
import { expect, it } from 'vitest';
import { readSlots, type ReadSlotEntry } from '../src/renderer/src/plugins/readSlots';
import type { ArchiveAttachment, ArchiveMessage, DirectoryChannel } from '@shared/contract';
import { anchorCatalog, catalogSlotAnchor } from '@shared/bundledCheck';
import { audiencesOf } from '@shared/pluginChannels';
import { defineChannels, definePlugin } from '@plugin-sdk/shared';

/** Read slots over `entries`, placed as the build's catalog of their declarations places them. */
const slotsOf = (entries: readonly ReadSlotEntry[], enabled: (id: string) => boolean, mayCall: (id: string, name: string) => boolean) =>
  readSlots(() => entries, enabled, mayCall, catalogSlotAnchor(anchorCatalog(entries.map((e) => e.plugin))));

it(
  'shows person sections, headings and search tokens in build order and removes them when off or absent',
  () => {
    let enabled = true;
    const Component = (_props: { userId: string }) => null;
    const entry: ReadSlotEntry = {
      plugin: {
        manifest: {
          id: 'probe',
          name: 'Probe',
          version: '1',
          description: '',
        },
        search: {
          tokens: [{
            key: 'probe',
            description: 'Probed',
            value: 'probe',
          }],
        },
        slots: { personSections: [{ id: 'tags' }], messageMenu: [{ id: 'menu' }] },
      },
      contributions: {
        personSections: { tags: { Component } },
        messageMenu: {
          menu: {
            heading: 'Probe',
            calls: [],
            menu: () => [{
              label: 'New item…',
              icon: 'plus',
              run: () => undefined,
            }],
          },
        },
      },
    };
    const slots = slotsOf([entry], () => enabled, () => true);
    const message = {
      id: 'm',
      labels: [],
    } as unknown as ArchiveMessage;
    expect(slots.people()).toEqual([{
      id: 'probe.tags',
      Component,
    }]);
    expect(slots.people()[0]!.Component({ userId: 'u' })).toBeNull();
    expect(slots.messages(message, { drawsAttachments: false })).toMatchObject([{
      id: 'probe.menu',
      heading: 'Probe',
      items: [{ label: 'New item…' }],
    }]);
    expect(slots.search()).toEqual([{
      key: 'probe',
      description: 'Probed',
      value: 'probe',
    }]);
    enabled = false;
    expect(slots.people()).toEqual([]);
    expect(slots.messages(message, { drawsAttachments: false })).toEqual([]);
    expect(slots.search()).toEqual([]);
    expect(slotsOf([], () => true, () => true).people()).toEqual([]);
  },
);

it("gives a person's links to the first active plugin view, and to the host's plain list when none is on", () => {
  let enabled = true;
  const Component = (_props: { userId: string }) => null;
  const entry = (id: string): ReadSlotEntry => ({
    plugin: { manifest: { id, name: id, version: '1', description: '' }, slots: { personLinks: [{ id: 'previews' }] } },
    contributions: { personLinks: { previews: { Component } } },
  });
  const slots = slotsOf([entry('first'), entry('second')], (id) => enabled || id === 'second', () => true);
  expect(slots.personLinks()).toEqual({ id: 'first.previews', Component });
  // The first turned off: the next active view takes over.
  enabled = false;
  expect(slots.personLinks()).toEqual({ id: 'second.previews', Component });
  // None on, or none built in: null, and the Person window lists the links plainly.
  expect(slotsOf([entry('first')], () => false, () => true).personLinks()).toBeNull();
  expect(slotsOf([], () => true, () => true).personLinks()).toBeNull();
});

it("offers a plugin's menu actions only in windows that may make their core calls", () => {
  const plugin = definePlugin({
    manifest: { id: 'voice', name: 'Voice', version: '1', description: '' },
    channels: defineChannels<{ core: { status(): string; request(id: string): void } }>()({
      core: { status: { audiences: ['renderer', 'phone'], writes: false }, request: ['renderer'] },
    }),
    slots: { messageMenu: [{ id: 'transcribe' }], attachmentMenu: [{ id: 'transcribe' }] },
  });
  const menuItem = { label: 'Transcribe', icon: 'waveform' as const, run: () => undefined };
  const entry = {
    plugin,
    contributions: {
      messageMenu: { transcribe: { calls: ['request'], menu: () => [menuItem] } },
      attachmentMenu: { transcribe: { calls: ['request'], item: () => menuItem } },
      channels: { calls: ['request'], jevItems: () => [menuItem] },
    },
  } as unknown as ReadSlotEntry;
  const message = { id: 'm', labels: [], attachments: [] } as unknown as ArchiveMessage;
  const channel = { id: 'c' } as DirectoryChannel;
  const attachment = { id: 'a' } as ArchiveAttachment;
  // The request call serves desktop windows only, so the phone offers no Transcribe item.
  const mayCallFrom = (audience: 'renderer' | 'phone') => (id: string, name: string) =>
    id === plugin.manifest.id && audiencesOf(plugin.channels, 'core', name).includes(audience);
  const desktop = slotsOf([entry], () => true, mayCallFrom('renderer'));
  expect(desktop.messages(message, { drawsAttachments: true }).flatMap((g) => g.items)).toEqual([menuItem]);
  expect(desktop.channels(channel)).toEqual([menuItem]);
  expect(desktop.attachments(message, attachment, [])).toEqual([menuItem]);
  const phone = slotsOf([entry], () => true, mayCallFrom('phone'));
  expect(phone.messages(message, { drawsAttachments: true })).toEqual([]);
  expect(phone.channels(channel)).toEqual([]);
  expect(phone.attachments(message, attachment, [])).toEqual([]);
});
