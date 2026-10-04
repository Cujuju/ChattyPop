// Recent channels: the switcher lists them first, and the back shortcut flips between the last two.
import { describe, expect, it } from 'vitest';
import {
  RECENT_CHANNELS_MAX,
  normalizeRecentChannels,
  previousChannel,
  switcherOrder,
  withRecent,
  type SwitcherChannel,
} from '../src/renderer/src/state/channelRecentsRules';

const channel = (id: string, name: string, lastTs: number | null, guildName = 'Guild'): SwitcherChannel => ({ id, name, guildName, lastTs });
const ids = (list: readonly SwitcherChannel[]): string[] => list.map((c) => c.id);

describe('recent channels', () => {
  it('moves a shown channel to the front, once, keeping at most the cap', () => {
    expect(withRecent(['b', 'a'], 'a')).toEqual(['a', 'b']);
    expect(withRecent([], 'a')).toEqual(['a']);
    const full = Array.from({ length: RECENT_CHANNELS_MAX }, (_, i) => `c${i}`);
    expect(withRecent(full, 'new')).toEqual(['new', ...full.slice(0, -1)]);
  });

  it('reads a stored list as distinct ids within the cap', () => {
    expect(normalizeRecentChannels(['a', 'a', 7, 'b'])).toEqual(['a', 'b']);
    expect(normalizeRecentChannels('a')).toEqual([]);
    expect(normalizeRecentChannels(Array.from({ length: RECENT_CHANNELS_MAX + 1 }, (_, i) => `c${i}`))).toHaveLength(RECENT_CHANNELS_MAX);
  });

  it('goes back to the most recent other channel that can be shown', () => {
    const all = () => true;
    expect(previousChannel(['a', 'b', 'c'], 'a', all)).toBe('b');
    // Flipping: after going back to b, a is the previous one.
    expect(previousChannel(withRecent(['a', 'b', 'c'], 'b'), 'b', all)).toBe('a');
    expect(previousChannel(['a', 'b', 'c'], 'a', (id) => id !== 'b')).toBe('c');
    expect(previousChannel(['a'], 'a', all)).toBeNull();
    expect(previousChannel(['a'], null, all)).toBe('a');
  });
});

describe('switcher order', () => {
  const general = channel('g', 'general', 10, 'Server');
  const random = channel('r', 'random', 30, 'Server');
  const dm = channel('d', 'alice', 20, 'Direct Messages');
  const all = [general, random, dm];

  it('lists recent channels first, most recent first, then the rest by latest activity; the shown one is not recent', () => {
    expect(ids(switcherOrder(all, [], null, ''))).toEqual(['r', 'd', 'g']);
    expect(ids(switcherOrder(all, ['g', 'd'], null, ''))).toEqual(['g', 'd', 'r']);
    // Shown: g. The first row is the channel to go back to.
    expect(ids(switcherOrder(all, ['g', 'd'], 'g', ''))).toEqual(['d', 'r', 'g']);
  });

  it('filters by every typed word, in the name or the server', () => {
    expect(ids(switcherOrder(all, [], null, 'GEN'))).toEqual(['g']);
    expect(ids(switcherOrder(all, [], null, 'direct ali'))).toEqual(['d']);
    expect(ids(switcherOrder(all, [], null, 'server'))).toEqual(['r', 'g']);
    expect(switcherOrder(all, [], null, 'nothing')).toEqual([]);
  });
});
