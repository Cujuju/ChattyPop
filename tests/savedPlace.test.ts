// The Bookmarks panel's place: a server lists its channels' and threads' saved messages; a channel, its own and its threads'.
import { describe, expect, it } from 'vitest';
import { DM_GUILD_ID } from '@shared/discord';
import { normalizeSavedPlace, savedWithin } from '@shared/savedMessages';

const HOME = '100000000000000001';
const GENERAL = '200000000000000001';
const NEWS = '200000000000000002';
const THREAD = '300000000000000001';
const DM = '400000000000000001';
const parents: Record<string, string> = { [THREAD]: GENERAL };
const threadParent = (id: string): string | null => parents[id] ?? null;
const at = (channelId: string, guildId: string | null = HOME) => ({ channelId, guildId });

describe('savedWithin', () => {
  it('everywhere lists every saved message', () => {
    expect(savedWithin(at(DM, null), null, threadParent)).toBe(true);
  });

  it('a server lists its own, and DMs sit under the DM server', () => {
    expect(savedWithin(at(NEWS), { by: 'guild', id: HOME }, threadParent)).toBe(true);
    expect(savedWithin(at(DM, null), { by: 'guild', id: HOME }, threadParent)).toBe(false);
    expect(savedWithin(at(DM, null), { by: 'guild', id: DM_GUILD_ID }, threadParent)).toBe(true);
  });

  it("a channel lists its own and its threads', not another channel's", () => {
    const general = { by: 'channel', id: GENERAL } as const;
    expect(savedWithin(at(GENERAL), general, threadParent)).toBe(true);
    expect(savedWithin(at(THREAD), general, threadParent)).toBe(true);
    expect(savedWithin(at(NEWS), general, threadParent)).toBe(false);
  });
});

describe('normalizeSavedPlace', () => {
  it('keeps a place and reads anything else as everywhere', () => {
    expect(normalizeSavedPlace({ by: 'channel', id: GENERAL })).toEqual({ by: 'channel', id: GENERAL });
    for (const v of [null, 'x', { by: 'role', id: GENERAL }, { by: 'guild', id: '' }]) expect(normalizeSavedPlace(v)).toBeNull();
  });
});
