import { createRequire } from 'node:module';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachmentSpoilerKey, embedSpoilerKey, linkSpoilerKey, normalizeLocalSpoilers } from '@shared/localSpoilers';
import { SETTINGS_KEYS } from '@shared/settings';
import { DESKTOP_CONNECTED_EVENT, PHONE_UNSHARED_SETTINGS, isPhoneDeviceSetting, phoneAppEvent, phoneMayWriteSetting, phoneSetting } from '@shared/phone';
import { isRemoteDeviceSetting } from '@shared/remoteDevice';

vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
const host = vi.hoisted(() => ({
  writes: [] as [string, unknown][],
  stored: ['restored'] as unknown,
  refuse: false,
  refuseRead: false,
  holdRead: false,
  reads: [] as (() => void)[],
  holdWrite: false,
  replies: [] as (() => void)[],
  window: new EventTarget(),
  listeners: [] as ((event: unknown) => void)[],
}));
vi.mock('@/api', () => ({ api: {
  core: {
    getSetting: async () => {
      if (host.refuseRead) throw new Error('Desktop unavailable');
      const value = host.stored;
      if (host.holdRead) await new Promise<void>((resolve) => host.reads.push(resolve));
      return value;
    },
    setLocalSpoiler: async (key: string, marked: boolean) => {
      if (host.refuse) throw new Error('Storage unavailable');
      const marks = new Set(normalizeLocalSpoilers(host.stored));
      if (marked) marks.add(key);
      else marks.delete(key);
      const value = [...marks];
      host.stored = value;
      host.writes.push([SETTINGS_KEYS.localSpoilers, value]);
      if (host.holdWrite) await new Promise<void>((resolve) => host.replies.push(resolve));
      return value;
    },
  },
  onEvent: (listener: (event: unknown) => void) => { host.listeners.push(listener); return () => undefined; },
} }));
vi.stubGlobal('window', host.window);
afterAll(() => vi.unstubAllGlobals());
const statePath = '../src/renderer/src/state/localSpoilers';
const parserPath = '../src/renderer/src/ui/mdParse';
const state = await import(statePath) as { isLocalSpoiler(key: string): boolean; setLocalSpoiler(key: string, marked: boolean): Promise<void> };
const { senderSpoilerLinks } = await import(parserPath) as { senderSpoilerLinks(text: string): ReadonlySet<string> };
const changed = (value: unknown): void => {
  host.stored = value;
  host.listeners.forEach((listener) => listener({ type: 'setting-changed', key: SETTINGS_KEYS.localSpoilers, value }));
};
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));
const reconnect = (): void => { host.window.dispatchEvent(new Event(DESKTOP_CONNECTED_EVENT)); };

describe('local spoiler storage', () => {
  it('restores marks and validates malformed stored values', () => {
    expect(state.isLocalSpoiler('restored')).toBe(true);
    expect(normalizeLocalSpoilers(['one', 'one', '', null, 4, 'two'])).toEqual(['one', 'two']);
    expect(normalizeLocalSpoilers({ one: true })).toEqual([]);
  });

  describe('changes', () => {
    beforeEach(() => {
      changed([]); host.writes = []; host.refuse = false; host.refuseRead = false;
      host.holdRead = false; host.reads = []; host.holdWrite = false; host.replies = [];
    });

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

    it('refreshes missed desktop additions and removals when the phone reconnects', async () => {
      host.stored = ['desktop'];
      reconnect();
      await settle();
      expect(state.isLocalSpoiler('desktop')).toBe(true);
      host.stored = [];
      reconnect();
      await settle();
      expect(state.isLocalSpoiler('desktop')).toBe(false);
    });

    it('keeps the last covers on a failed refresh and recovers at the next connection', async () => {
      changed(['kept']);
      host.refuseRead = true;
      reconnect();
      await settle();
      expect(state.isLocalSpoiler('kept')).toBe(true);
      host.refuseRead = false;
      host.stored = ['current'];
      reconnect();
      await settle();
      expect(state.isLocalSpoiler('kept')).toBe(false);
      expect(state.isLocalSpoiler('current')).toBe(true);
    });

    it('ignores a stale reconnect snapshot when a newer desktop event arrives', async () => {
      host.stored = ['old'];
      host.holdRead = true;
      reconnect();
      changed(['new']);
      host.reads[0]!();
      await settle();
      expect(state.isLocalSpoiler('old')).toBe(false);
      expect(state.isLocalSpoiler('new')).toBe(true);
    });

    it('changes current archive marks even when this device missed an event', async () => {
      host.stored = ['desktop'];
      await state.setLocalSpoiler('phone', true);
      expect(host.writes.at(-1)).toEqual([SETTINGS_KEYS.localSpoilers, ['desktop', 'phone']]);
      expect(state.isLocalSpoiler('desktop')).toBe(true);
    });

    it('ignores a write reply older than a newly delivered archive event', async () => {
      host.holdWrite = true;
      const write = state.setLocalSpoiler('phone', true);
      await settle();
      changed(['phone', 'desktop']);
      host.replies[0]!();
      await write;
      expect(state.isLocalSpoiler('desktop')).toBe(true);
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

  it('shares archive marks, changes and events with phones and remote desktops', () => {
    const key = SETTINGS_KEYS.localSpoilers;
    const value = ['one'];
    const event = { type: 'setting-changed', key, value } as const;
    expect(isPhoneDeviceSetting(key)).toBe(false);
    expect(PHONE_UNSHARED_SETTINGS).not.toContain(key);
    expect(isRemoteDeviceSetting(key)).toBe(false);
    expect(phoneSetting(key, value)).toEqual(value);
    expect(phoneMayWriteSetting(key)).toBe(true);
    expect(phoneAppEvent(event)).toEqual(event);
  });
});
