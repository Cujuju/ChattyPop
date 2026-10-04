// Contract (docs/dms.md §4.1, §4.4): the rename and leave dialogs close once their conversation leaves the list (privacy
// mode hid it, it closed, another account signed in), so nothing of it, its name included, stays on screen. DM rows are
// keyed by channel id, so a directory read keeps them (focus, arrow keys); the mute flyout finds its row as it opens.
// While a group's roster is unknown, its members flyout claims no count, no crown and no removing. Mark as read is offered
// only while the DM is unread by the sidebar's rule (dmRules.isUnread), so a read DM sends Discord no ack. While posting is
// locked, the menus offer no Discord write (mute, rename, add, leave, close) and an open dialog closes.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type { DirectoryChannel } from '@shared/contract';
import { DM_CHANNEL_TYPE, DM_GUILD_ID, GROUP_DM_CHANNEL_TYPE } from '@shared/discord';
import { isUnread, type DmChannel } from '../src/renderer/src/state/dmRules';
import { setPostingUnlocked } from './postingSwitch';

// The client runtime, so effects run as in a window (node resolves solid-js to its server build).
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);

const env = vi.hoisted(() => ({ list: (_channels: DirectoryChannel[]): void => undefined, menus: [] as unknown[] }));
vi.mock('../src/renderer/src/state/directory', async () => {
  const { createRequire: req } = await import('node:module');
  const { createSignal } = req(import.meta.url)('solid-js/dist/solid.cjs') as typeof import('solid-js');
  const [listed, setListed] = createSignal<DirectoryChannel[]>([]);
  env.list = (channels) => void setListed(channels);
  return { channelById: (id: string) => listed().find((c) => c.id === id), refetchDirectory: async () => undefined, setChannelOptIn: async () => undefined };
});
vi.mock('@/api', () => ({ api: {} }));
vi.mock('../src/renderer/src/state/archive', () => ({ openLive: () => undefined }));
vi.mock('../src/renderer/src/state/channelPolicy', () => ({ channelJevItems: () => [], localAiItem: () => ({ label: 'Local AI only', run: () => undefined }) }));
vi.mock('../src/renderer/src/state/dms', () => ({ dmMuted: () => false }));
vi.mock('../src/renderer/src/state/newMessage', () => ({ openAddFriends: () => undefined }));
vi.mock('../src/renderer/src/state/person', () => ({ openPerson: () => undefined }));
vi.mock('../src/renderer/src/state/privacy', () => ({ channelPrivacyItem: () => ({ label: 'Private', run: () => undefined }) }));
vi.mock('../src/renderer/src/state/ui', () => ({ openMenuAt: (anchor: unknown) => void env.menus.push(anchor) }));
vi.mock('virtual:bundled-plugins/shared', async () => (await import('./postingSwitch')).bundledPluginsModule);
vi.mock('../src/renderer/src/state/plugins', async () => (await import('./postingSwitch')).pluginsModule);

// A renderer module: imported by path so the node type-check doesn't follow it.
const statePath = '../src/renderer/src/state/dmActions';
type Menu = { items: { label: string; run: () => unknown }[] }[];
const { dmDialog, dmMenu, membersMenu, muteItem } = (await import(statePath)) as {
  dmDialog(): { kind: string; channelId: string } | null;
  dmMenu(c: DirectoryChannel): Menu;
  membersMenu(c: DirectoryChannel): (Menu[number] & { heading?: string; items: { icon?: string }[] })[];
  muteItem(c: DirectoryChannel, anchor: () => unknown, surface: string, side: string): { run(): void };
};
const { keyedRows } =(await import('../src/renderer/src/ui/keyedRows')) as typeof import('../src/renderer/src/ui/keyedRows');
const { createRoot, createSignal, mapArray } = createRequire(import.meta.url)('solid-js/dist/solid.cjs') as typeof import('solid-js');

const GROUP = '400000000000000002';
function group(closed = false): DirectoryChannel {
  return {
    id: GROUP,
    guildId: DM_GUILD_ID,
    name: 'Secret plans',
    kind: GROUP_DM_CHANNEL_TYPE,
    parentId: null,
    optedIn: false,
    messageCount: 0,
    newCount: 0,
    notableCount: 0,
    mentionCount: 0,
    lastTs: null,
    localAiOnly: false,
    textTier: null,
    hideInPrivacy: true,
    icon: null,
    peer: null,
    dm: { recipients: [], rosterKnown: true, ownerId: null, lastMessageId: null, ackId: null, muteEndsMs: null, closed, request: false, archived: 'never', preview: null },
  };
}
const open = (label: string): void => {
  const item = dmMenu(group()).flatMap((g) => g.items).find((i) => i.label === label);
  item!.run();
};

describe('the DM dialogs', () => {
  it('close once their conversation leaves the list, or closes', () => {
    for (const label of ['Rename…', 'Leave group…']) {
      env.list([group()]);
      open(label);
      expect(dmDialog()?.channelId).toBe(GROUP);
      // Privacy mode hides it.
      env.list([]);
      expect(dmDialog()).toBeNull();
    }
    env.list([group()]);
    open('Rename…');
    env.list([group(true)]);
    expect(dmDialog()).toBeNull();
  });
});

describe("a group's members", () => {
  const SELF_OWNED = { ownerId: '900000000000000001', recipients: [{ id: '110000000000000001', name: 'Bob', avatar: null }] };
  const members = (dm: Partial<NonNullable<DirectoryChannel['dm']>>) => {
    const c = group();
    return membersMenu({ ...c, dm: { ...c.dm!, ...dm } });
  };
  const labels = (m: ReturnType<typeof members>): string[] => m.flatMap((g) => g.items.map((i) => i.label));

  it('known: their count, your crown when you own it, and removing people in Discord', () => {
    const m = members({ ...SELF_OWNED, rosterKnown: true });
    expect(m[0]!.heading).toBe('Members · 2');
    expect(m[0]!.items[0]).toMatchObject({ label: 'You', icon: 'crown' });
    expect(labels(m)).toContain('Remove people in Discord');
  });

  it('unknown: no count, no crown on You, and no removing', () => {
    const m = members({ ownerId: SELF_OWNED.ownerId, recipients: [], rosterKnown: false });
    expect(m[0]!.heading).toBe('Members unknown');
    expect(m[0]!.items[0]).toMatchObject({ label: 'You', icon: 'person' });
    expect(labels(m)).not.toContain('Remove people in Discord');
  });
});

describe('Mark as read', () => {
  const OLDER = '500000000000000001';
  const NEWER = '500000000000000002';
  const at = (dm: Partial<NonNullable<DirectoryChannel['dm']>>, mentionCount = 0): DirectoryChannel => {
    const c = group();
    return { ...c, mentionCount, dm: { ...c.dm!, ...dm } };
  };
  const offered = (c: DirectoryChannel): boolean => dmMenu(c).some((g) => g.items.some((i) => i.label === 'Mark as read'));

  it("is offered only while the DM is unread by the sidebar's rule: a read DM sends no ack", () => {
    const cases: [DirectoryChannel, boolean][] = [
      [at({ lastMessageId: NEWER, ackId: OLDER }), true],
      [at({ lastMessageId: OLDER, ackId: OLDER }), false],
      [at({ lastMessageId: OLDER, ackId: NEWER }), false],
      [at({ lastMessageId: NEWER, ackId: null }), false],
      [at({ lastMessageId: OLDER, ackId: OLDER }, 1), true],
      [at({ lastMessageId: null, ackId: null }), false],
    ];
    for (const [c, unread] of cases) {
      expect(isUnread(c as DmChannel)).toBe(unread);
      expect(offered(c)).toBe(unread);
    }
  });
});

describe('DM rows', () => {
  it('outlive a directory read that makes new objects for the same channels, and show the newest', () => {
    createRoot((dispose) => {
      const [list, setList] = createSignal([group()]);
      const rows = keyedRows(list);
      let made = 0;
      const drawn = mapArray(rows.ids, (id) => (made++, id));
      drawn();
      setList([{ ...group(), name: 'Renamed' }]);
      drawn();
      expect(made).toBe(1);
      expect(rows.item(GROUP)?.name).toBe('Renamed');
      dispose();
    });
  });

  it("open the mute flyout at the row as drawn now, and none once it's gone", () => {
    env.menus.length = 0;
    let row: { isConnected: boolean } | null = { isConnected: true };
    const item = muteItem(group(), () => row, 'list', 'beside');
    item.run();
    row = null;
    item.run();
    row = { isConnected: false };
    item.run();
    expect(env.menus).toEqual([{ isConnected: true }]);
  });
});

describe('while posting is locked', () => {
  const WRITES = ['Mute…', 'Rename…', 'Add friends…', 'Leave group…', 'Close DM'];
  const unread = (c: DirectoryChannel): DirectoryChannel => ({ ...c, mentionCount: 1 });
  const oneToOne = (): DirectoryChannel => ({ ...group(), kind: DM_CHANNEL_TYPE });
  const labels = (menu: Menu): string[] => menu.flatMap((g) => g.items.map((i) => i.label));
  const writes = (menu: Menu): string[] => labels(menu).filter((l) => WRITES.includes(l));

  it('the DM menus offer no Discord write, keep Mark as read, and offer them again once it unlocks', () => {
    setPostingUnlocked(false);
    for (const c of [unread(group()), unread(oneToOne())]) {
      expect(writes(dmMenu(c))).toEqual([]);
      expect(labels(dmMenu(c))).toEqual(expect.arrayContaining(['Mark as read', 'Open in Discord']));
      expect(writes(membersMenu(c))).toEqual([]);
    }
    setPostingUnlocked(true);
    expect(writes(dmMenu(group()))).toEqual(['Mute…', 'Rename…', 'Add friends…', 'Leave group…']);
    expect(writes(dmMenu(oneToOne()))).toEqual(['Mute…', 'Add friends…', 'Close DM']);
    expect(writes(membersMenu(group()))).toEqual(['Add friends…']);
  });

  it('an open rename or leave dialog closes when posting locks', () => {
    for (const label of ['Rename…', 'Leave group…']) {
      setPostingUnlocked(true);
      env.list([group()]);
      open(label);
      expect(dmDialog()?.channelId).toBe(GROUP);
      setPostingUnlocked(false);
      expect(dmDialog()).toBeNull();
    }
    setPostingUnlocked(true);
  });
});
