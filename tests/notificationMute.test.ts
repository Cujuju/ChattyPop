// Contract tests for muted places (src/core/queries/notificationMute.ts) and the host notification policy (src/main/notifications.ts).
import { describe, expect, it } from 'vitest';
import { notificationService } from '../src/main/notifications';
import { Archive } from '../src/core/archive';
import { setSetting } from '../src/core/db';
import { allMuted, notificationMuted } from '../src/core/queries/notificationMute';
import type { DeliveredNotification, NotificationRequest } from '@shared/notifications';
import { SETTINGS_KEYS, type MutedPlaces } from '@shared/settings';
import { tempDb } from './helpers';

/** Snowflake-shaped ids, as the archive's server switches require. */
const [G1, G2, C1, C2, T1, C3] = ['100000000000000001', '100000000000000002', '200000000000000001', '200000000000000002', '300000000000000001', '200000000000000003'];

/** An archive with server G1 (channels C1, C2 and thread T1 in C1) and server G2 (channel C3), muting `muted`. */
function archive(muted: MutedPlaces, privacy = false) {
  const db = tempDb();
  const a = new Archive(db);
  a.upsertGuilds([{ id: G1, name: 'One' }, { id: G2, name: 'Two' }]);
  a.upsertChannels(G1, [{ id: C1, name: 'a', type: 0 }, { id: C2, name: 'b', type: 0 }]);
  a.upsertChannels(G2, [{ id: C3, name: 'c', type: 0 }]);
  a.setOptIn(C1, true);
  a.upsertThreads([{ id: T1, name: 't', type: 11, parent_id: C1 } as never], 0);
  setSetting(db, SETTINGS_KEYS.notifications, { desktop: true, muted });
  if (privacy) {
    a.setChannelPolicy(C1, { hideInPrivacy: true });
    setSetting(db, 'privacyMode', true);
  }
  return db;
}

describe('muted places', () => {
  it.each([
    ['a muted channel', { guildIds: [], channelIds: [C1] }, C1],
    ['a thread of a muted channel', { guildIds: [], channelIds: [C1] }, T1],
    ['a channel in a muted server', { guildIds: [G1], channelIds: [] }, C2],
    ['a thread in a muted server', { guildIds: [G1], channelIds: [] }, T1],
  ])('mute %s', (_, muted, channelId) => {
    expect(notificationMuted(archive(muted), channelId)).toBe(true);
  });

  it('leave other servers and channels, and channels the archive does not list, unmuted', () => {
    const db = archive({ guildIds: [G1], channelIds: [C2] });
    expect([C3, '999'].map((id) => notificationMuted(db, id))).toEqual([false, false]);
  });

  it('still mute a thread whose channel privacy mode hides', () => {
    expect(notificationMuted(archive({ guildIds: [], channelIds: [C1] }, true), T1)).toBe(true);
  });

  it('mute a set of channels only when there is one and every one is muted', () => {
    const db = archive({ guildIds: [G2], channelIds: [C1] });
    expect(allMuted(db, [C1, T1, C3])).toBe(true);
    expect(allMuted(db, [C1, C2])).toBe(false);
    expect(allMuted(db, [])).toBe(false);
  });
});

function service(mutedIds: string[], desktopOn = true) {
  const sent = { desktop: [] as DeliveredNotification[], phone: [] as DeliveredNotification[] };
  const notifications = notificationService({
    settings: async () => ({ notifications: { desktop: desktopOn, muted: { guildIds: [], channelIds: [] } } }),
    desktop: (n) => void sent.desktop.push(n),
    push: (n) => void sent.phone.push(n),
    privacyScoped: () => false,
    muted: async (channelIds) => channelIds.every((id) => mutedIds.includes(id)),
  });
  return { notifications, sent };
}

const about = (channelId: string, extra: Partial<NotificationRequest> = {}): NotificationRequest => ({
  title: 't',
  body: 'b',
  target: { kind: 'message', channelId, messageId: 'm' },
  ...extra,
});

describe('host notification policy', () => {
  it('sends nothing to any device about a muted channel', async () => {
    const { notifications, sent } = service([C1]);
    await notifications.show(about(C1));
    expect(sent).toEqual({ desktop: [], phone: [] });
  });

  it('still sends about other channels, and notices that name no channel', async () => {
    const { notifications, sent } = service([C1]);
    await notifications.show(about(C3));
    await notifications.show({ title: 't', body: 'b', target: { kind: 'panel', panelId: 'p' } });
    expect(sent.phone).toHaveLength(2);
    expect(sent.desktop).toHaveLength(2);
  });

  it('sends nothing about channels that are all muted, and sends about a mix without naming them', async () => {
    const { notifications, sent } = service([C1, C2]);
    const summary = (aboutChannels: string[]): NotificationRequest => ({ title: 't', body: 'b', target: null, aboutChannels });
    await notifications.show(summary([C1, C2]));
    expect(sent).toEqual({ desktop: [], phone: [] });
    await notifications.show(summary([C1, C3]));
    await notifications.show(summary([]));
    expect(sent.phone).toHaveLength(2);
    expect(sent.desktop).toHaveLength(2);
    expect(sent.phone[0]).not.toHaveProperty('aboutChannels');
  });

  it('keeps a request marked phone: false off phones, and desktop: false off the desktop', async () => {
    const { notifications, sent } = service([]);
    await notifications.show(about(C1, { phone: false }));
    await notifications.show(about(C1, { desktop: false }));
    expect(sent.desktop).toHaveLength(1);
    expect(sent.phone).toHaveLength(1);
    expect(sent.desktop[0]!.phone).toBe(false);
  });

  it('pushes to phones with Windows notifications off', async () => {
    const { notifications, sent } = service([], false);
    await notifications.show(about(C1));
    expect(sent).toMatchObject({ desktop: [], phone: [expect.anything()] });
  });
});
