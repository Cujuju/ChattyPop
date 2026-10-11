import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { attachmentSpoilerKey, embedSpoilerKey, linkSpoilerKey, normalizeLocalSpoilers } from '@shared/localSpoilers';
import { SETTINGS_KEYS } from '@shared/settings';
import { PHONE_DEVICE_SETTINGS, PHONE_UNSHARED_SETTINGS } from '@shared/phoneDevice';
import { isRemoteDeviceSetting } from '@shared/remoteDevice';

vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
const host = vi.hoisted(() => ({
  writes: [] as [string, unknown][],
  refuse: false,
  listeners: [] as ((event: unknown) => void)[],
}));
vi.mock('@/api', () => ({ api: {
  core: {
    getSetting: async () => ['restored'],
    setSetting: async (key: string, value: unknown) => {
      if (host.refuse) throw new Error('Storage unavailable');
      host.writes.push([key, value]);
    },
  },
  onEvent: (listener: (event: unknown) => void) => { host.listeners.push(listener); return () => undefined; },
} }));
const statePath = '../src/renderer/src/state/localSpoilers';
const parserPath = '../src/renderer/src/ui/mdParse';
const state = await import(statePath) as { isLocalSpoiler(key: string): boolean; setLocalSpoiler(key: string, marked: boolean): Promise<void> };
const { senderSpoilerLinks } = await import(parserPath) as { senderSpoilerLinks(text: string): ReadonlySet<string> };
const changed = (value: unknown): void => host.listeners.forEach((listener) => listener({ type: 'setting-changed', key: SETTINGS_KEYS.localSpoilers, value }));

describe('local spoiler storage', () => {
  it('restores marks and validates malformed stored values', () => {
    expect(state.isLocalSpoiler('restored')).toBe(true);
    expect(normalizeLocalSpoilers(['one', 'one', '', null, 4, 'two'])).toEqual(['one', 'two']);
    expect(normalizeLocalSpoilers({ one: true })).toEqual([]);
  });

  describe('changes', () => {
    beforeEach(() => { changed([]); host.writes = []; host.refuse = false; });

    it('persists only selected parts, serializes quick changes, and removes one without dropping the others', async () => {
      const one = attachmentSpoilerKey('one');
      const two = linkSpoilerKey('message', 'https://example.com/two');
      await Promise.all([state.setLocalSpoiler(one, true), state.setLocalSpoiler(two, true)]);
      expect(state.isLocalSpoiler(one)).toBe(true);
      expect(state.isLocalSpoiler(two)).toBe(true);
      expect(host.writes.at(-1)).toEqual([SETTINGS_KEYS.localSpoilers, [one, two]]);
      await state.setLocalSpoiler(one, false);
      expect(state.isLocalSpoiler(one)).toBe(false);
      expect(state.isLocalSpoiler(two)).toBe(true);
      expect(host.writes.at(-1)).toEqual([SETTINGS_KEYS.localSpoilers, [two]]);
    });

    it('adopts other-window changes and leaves refused writes unchanged, then recovers', async () => {
      changed(['other-window']);
      expect(state.isLocalSpoiler('other-window')).toBe(true);
      host.refuse = true;
      await expect(state.setLocalSpoiler('failed', true)).rejects.toThrow('Storage unavailable');
      expect(state.isLocalSpoiler('failed')).toBe(false);
      expect(state.isLocalSpoiler('other-window')).toBe(true);
      host.refuse = false;
      await state.setLocalSpoiler('later', true);
      expect(host.writes.at(-1)).toEqual([SETTINGS_KEYS.localSpoilers, ['other-window', 'later']]);
    });
  });
});

describe('content identity and provenance', () => {
  it('shares one mark between a link and its preview, but keeps other messages and content separate', () => {
    expect(linkSpoilerKey('m', 'https://EXAMPLE.com')).toBe(linkSpoilerKey('m', 'https://example.com/'));
    expect(linkSpoilerKey('m', 'https://example.com/')).not.toBe(linkSpoilerKey('other', 'https://example.com/'));
    expect(attachmentSpoilerKey('a')).not.toBe(attachmentSpoilerKey('b'));
    expect(embedSpoilerKey('m', 0)).not.toBe(embedSpoilerKey('m', 1));
  });

  it('recognizes sender spoiler links within formatting and quotes, excluding normal links and code', () => {
    expect([...senderSpoilerLinks('https://example.com/visible\n> ||**[hidden](https://example.com/hidden)**||\n`||https://example.com/code||`')]).toEqual(['https://example.com/hidden']);
    expect([...senderSpoilerLinks('||https://EXAMPLE.com||')]).toEqual(['https://example.com/']);
  });

  it('keeps phone and remote desktop marks on those devices', () => {
    expect(PHONE_DEVICE_SETTINGS[SETTINGS_KEYS.localSpoilers]!(['one', 'one'])).toEqual(['one']);
    expect(PHONE_UNSHARED_SETTINGS).toContain(SETTINGS_KEYS.localSpoilers);
    expect(isRemoteDeviceSetting(SETTINGS_KEYS.localSpoilers)).toBe(true);
  });
});
