// Tests phone calls, events, encoding, pairing QR codes, and static paths.
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { decodeWire, encodeWire } from '@plugin-sdk/shared';
import { PHONE_CORE_METHODS as COMPANION_CORE_METHODS, PHONE_EVENT_TYPES as COMPANION_EVENT_TYPES, phoneAppEvent, phoneGetsAppEvent, phoneMayCallCore, phoneMayWriteSetting } from '@shared/phone';
import { SETTINGS_KEYS } from '@shared/settings';
import { RENDERER_CORE_METHODS } from '@shared/contract';
import { staticFile } from '../src/main/plugins/pages';
import { voice } from './aPhoneEvents';
import { tempDir } from './helpers';

// The build's plugins: a fixture listing one event for the phone.
vi.mock('virtual:bundled-plugins/shared', async () => ({ default: (await import('./aPhoneEvents')).PHONE_EVENTS, catalog: null }));

/** Writes that must stay desktop-only: settings, keys, rules, plugins, storage, AI calls the owner didn't ask for. */
// setSetting reaches main only for shared config keys (phoneMayWriteSetting), never as a plain core call.
const DESKTOP_ONLY = ['setSetting', 'setChannelPolicy', 'pluginCall', 'jevAskRange', 'tagRange'];

describe('companion contract', () => {
  it('receives bot-count policy changes, can refresh the banner and pick bots, but writes no other setting', () => {
    const event = { type: 'setting-changed', key: SETTINGS_KEYS.countedBots, value: ['bot'] } as const;
    expect(phoneAppEvent(event)).toEqual(event);
    expect(phoneMayCallCore('channelUnreadSnapshot')).toBe(true);
    expect(phoneMayCallCore('archivedBots')).toBe(true);
    expect(phoneMayWriteSetting(SETTINGS_KEYS.countedBots)).toBe(true);
    expect(phoneMayWriteSetting(SETTINGS_KEYS.privacyMode)).toBe(false);
    expect(phoneMayCallCore('setSetting')).toBe(false);
  });
  it('lets the phone call only renderer methods, never the desktop-only ones', () => {
    for (const m of COMPANION_CORE_METHODS) expect(RENDERER_CORE_METHODS).toContain(m);
    for (const m of DESKTOP_ONLY) expect(COMPANION_CORE_METHODS).not.toContain(m);
  });

  it('keeps main’s work orders off the phone’s event stream', () => {
    for (const t of ['transcript-audio', 'open-message']) expect(COMPANION_EVENT_TYPES).not.toContain(t);
  });

  it("lets the phone make only the plugin calls and get only the plugin events their shared entries list", () => {
    expect(phoneMayCallCore('pluginCall')).toBe(false); // plugin calls go through the 'plugins' group, stamped 'phone'
    expect(phoneGetsAppEvent({ type: 'plugin-event', pluginId: voice.manifest.id, name: 'status', payload: null })).toBe(true);
    expect(phoneGetsAppEvent({ type: 'plugin-event', pluginId: voice.manifest.id, name: 'other', payload: null })).toBe(false);
    expect(phoneGetsAppEvent({ type: 'attachment-notes-changed', messageIds: [] })).toBe(true);
  });

  it("tells the phone when another account signs in, so it drops the last one's DMs", () => {
    expect(phoneGetsAppEvent({ type: 'self-changed', userId: '900000000000000002' })).toBe(true);
  });

  it('carries attachment bytes through JSON, including files larger than one conversion chunk', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
    const back = decodeWire(encodeWire({ files: [{ name: 'a.bin', bytes }] })) as { files: { bytes: Uint8Array }[] };
    expect(back.files[0]!.bytes).toEqual(bytes);
  });
});

describe('pairing QR code', () => {
  it('draws the quiet zone scanners need around the code', async () => {
    const { encode } = await import('uqr');
    const QUIET_ZONE_MODULES = 4;
    const url = 'https://pc.tail1.ts.net:8443/pair?code=123456';
    const bare = encode(url, { border: 0, ecc: 'M' });
    const framed = encode(url, { border: QUIET_ZONE_MODULES, ecc: 'M' });
    expect(framed.size).toBe(bare.size + 2 * QUIET_ZONE_MODULES);
    expect(framed.data[0]!.every((dark) => !dark)).toBe(true);
  });
});

describe('static files', () => {
  const root = join(tempDir(), 'renderer');
  it('finds a built page and its assets, and never leaves the build folder', () => {
    expect(staticFile(root, '/page.html')).toBe(join(root, 'page.html'));
    expect(staticFile(root, '/assets/app.js')).toBe(join(root, 'assets', 'app.js'));
    expect(staticFile(root, '/../secrets/x')).toBeNull();
    expect(staticFile(root, '/%2e%2e/%2e%2e/x')).toBeNull();
    expect(staticFile(root, '/%E0%A4%A')).toBeNull();
  });
});
