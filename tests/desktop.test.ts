import { describe, expect, it } from 'vitest';
import type { DirectoryChannel, DirectoryGuild } from '@shared/contract';
import { DEFAULT_DESKTOP_SETTINGS, hotkeyOf, indicatedUnread, isHotkey, normalizeDesktopSettings, type KeyChord } from '@shared/desktop';
import { NO_UNREAD, chatUnreadCount, normalizeUnreadTotals, unreadSummary, type UnreadKind } from '@shared/unread';
import { DOT_BGR, dotsBitmap, withDots, type Bitmap } from '../src/main/badgeImage';

const press = (code: string, held: Partial<Omit<KeyChord, 'code'>> = {}): KeyChord => ({
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...held,
});

describe('desktop hotkeys', () => {
  it('makes accelerators in a fixed modifier order', () => {
    expect(hotkeyOf(press('KeyP', { shiftKey: true, ctrlKey: true, altKey: true }))).toBe('Ctrl+Alt+Shift+P');
    expect(hotkeyOf(press('Digit3', { metaKey: true }))).toBe('Super+3');
    expect(hotkeyOf(press('F12', { altKey: true }))).toBe('Alt+F12');
    expect(hotkeyOf(press('Space', { ctrlKey: true }))).toBe('Ctrl+Space');
  });

  it('refuses presses that would take a typed character or are no key', () => {
    expect(hotkeyOf(press('KeyP'))).toBeNull();
    expect(hotkeyOf(press('KeyP', { shiftKey: true }))).toBeNull();
    expect(hotkeyOf(press('ControlLeft', { ctrlKey: true }))).toBeNull();
    expect(hotkeyOf(press('Semicolon', { ctrlKey: true }))).toBeNull();
  });

  it('accepts only hotkeys it makes', () => {
    expect(isHotkey('Ctrl+Shift+K')).toBe(true);
    expect(isHotkey('Shift+Ctrl+K')).toBe(false);
    expect(isHotkey('Ctrl+Ctrl+K')).toBe(false);
    expect(isHotkey('Shift+K')).toBe(false);
    expect(isHotkey('Ctrl+F25')).toBe(false);
    expect(isHotkey('K')).toBe(false);
  });
});


describe('desktop settings', () => {
  it('fills missing or invalid fields from the defaults', () => {
    expect(normalizeDesktopSettings(undefined)).toEqual(DEFAULT_DESKTOP_SETTINGS);
    expect(normalizeDesktopSettings({ closeToTray: false, hotkey: 'Shift+K', minimizeToTray: 'yes' })).toEqual({
      ...DEFAULT_DESKTOP_SETTINGS,
      closeToTray: false,
    });
    expect(normalizeDesktopSettings({ hotkey: 'Alt+F4' }).hotkey).toBe('Alt+F4');
  });

  it('indicates unread chat and not alerts by default, and keeps a valid choice', () => {
    expect([DEFAULT_DESKTOP_SETTINGS.indicateChat, DEFAULT_DESKTOP_SETTINGS.indicateAlerts]).toEqual([true, false]);
    expect(normalizeDesktopSettings({ indicateChat: 'no', indicateAlerts: 1 })).toEqual(DEFAULT_DESKTOP_SETTINGS);
    expect(normalizeDesktopSettings({ indicateChat: false, indicateAlerts: true })).toMatchObject({ indicateChat: false, indicateAlerts: true });
  });

  it('zeroes the unread kinds turned off', () => {
    const unread = { chat: 3, alerts: 2 };
    expect(indicatedUnread(unread, DEFAULT_DESKTOP_SETTINGS)).toEqual({ chat: 3, alerts: 0 });
    expect(indicatedUnread(unread, { ...DEFAULT_DESKTOP_SETTINGS, indicateChat: false, indicateAlerts: true })).toEqual({ chat: 0, alerts: 2 });
  });
});

describe('badge art', () => {
  /** Windows' small-icon size at 100%, where both dots must stay legible. */
  const SIZE = 16;
  const BYTES_PER_PIXEL = 4;
  const OPAQUE = 255;
  /** A pixel inside the corner slot's dot (chat), and one inside the slot left of it (alerts), on the bottom row of dots. */
  const CORNER: readonly [number, number] = [SIZE - 4, SIZE - 4];
  const BESIDE: readonly [number, number] = [3, SIZE - 4];
  /** The pixels between the two slots, on the same row. */
  const GAP = [7, 8];
  const blank = (size: number): Bitmap => ({ width: size, height: size, data: Buffer.alloc(size * size * BYTES_PER_PIXEL) });
  const pixel = (bmp: Bitmap, [x, y]: readonly [number, number]): number[] => {
    const at = (y * bmp.width + x) * BYTES_PER_PIXEL;
    return [...bmp.data.subarray(at, at + BYTES_PER_PIXEL)];
  };
  const dot = (kind: UnreadKind): number[] => [...DOT_BGR[kind], OPAQUE];

  it('paints chat in the corner, in blue, alone', () => {
    const bmp = dotsBitmap(SIZE, ['chat']);
    expect(pixel(bmp, CORNER)).toEqual(dot('chat'));
    expect(pixel(bmp, BESIDE)[3]).toBe(0);
    expect(pixel(bmp, [0, 0])[3]).toBe(0);
  });

  it('paints alerts beside the corner, in their own colour, even alone', () => {
    const bmp = dotsBitmap(SIZE, ['alerts']);
    expect(pixel(bmp, BESIDE)).toEqual(dot('alerts'));
    expect(pixel(bmp, CORNER)[3]).toBe(0);
    expect(DOT_BGR.alerts).not.toEqual(DOT_BGR.chat);
  });

  it('paints both side by side at 16 px, kept apart by a near-clear gap', () => {
    const bmp = dotsBitmap(SIZE, ['chat', 'alerts']);
    expect(pixel(bmp, CORNER)).toEqual(dot('chat'));
    expect(pixel(bmp, BESIDE)).toEqual(dot('alerts'));
    for (const x of GAP) expect(pixel(bmp, [x, CORNER[1]])[3]).toBeLessThan(OPAQUE / 8);
    expect(pixel(bmp, [CORNER[0], 0])[3]).toBe(0);
  });

  it('paints over the tray icon without changing it', () => {
    const icon = blank(SIZE * 2);
    const badged = withDots(icon, ['chat']);
    expect(pixel(badged, [icon.width - 4, icon.height - 4])).toEqual(dot('chat'));
    expect(pixel(badged, [2, 2])[3]).toBe(0);
    expect(icon.data.every((b) => b === 0)).toBe(true);
  });
});

describe('unread totals', () => {
  const channel = (mentionCount: number, dm?: { request: boolean }): DirectoryChannel =>
    ({ mentionCount, ...(dm ? { dm } : {}) }) as DirectoryChannel;

  it('counts chat as Discord does: every read-state count, message requests left out', () => {
    const guilds = [
      { channels: [channel(2), channel(0)] },
      { channels: [channel(3, { request: false }), channel(5, { request: true })] },
    ] as DirectoryGuild[];
    expect(chatUnreadCount(guilds)).toBe(5);
    expect(chatUnreadCount([])).toBe(0);
  });

  it('says which kinds are unread, for the tooltip and overlay', () => {
    expect(unreadSummary({ chat: 3, alerts: 2 })).toBe('3 messages, 2 alerts');
    expect(unreadSummary({ chat: 1, alerts: 0 })).toBe('1 message');
    expect(unreadSummary({ chat: 0, alerts: 1 })).toBe('1 alert');
    expect(unreadSummary(NO_UNREAD)).toBeNull();
  });

  it('reads totals from IPC as nonnegative integers per kind', () => {
    expect(normalizeUnreadTotals({ chat: 3, alerts: 2 })).toEqual({ chat: 3, alerts: 2 });
    expect(normalizeUnreadTotals({ chat: -1, alerts: 1.5 })).toEqual(NO_UNREAD);
    expect(normalizeUnreadTotals(7)).toEqual(NO_UNREAD);
  });
});
