// Desktop and phone spoiler changes share one archive, through the real phone gateway and renderer API.
import { afterEach, describe, expect, it } from 'vitest';
import type { AppEvent, RendererApi } from '@shared/contract';
import type { PhoneCall } from '@shared/phone';
import { SETTINGS_KEYS } from '@shared/settings';
import { getSetting, setSetting, type Db } from '../src/core/db';
import { localSpoilerHandlers } from '../src/core/localSpoilerHandlers';
import { PhoneHub } from '../src/main/phone/hub';
import { tempDb } from './helpers';

const phoneApiPath = '../src/plugin-sdk/renderer/shell/phoneApi';
const { createPhoneRendererApi } = await import(phoneApiPath) as {
  createPhoneRendererApi(transport: { call(call: PhoneCall): Promise<unknown>; listen(deliver: (event: AppEvent) => void): void }): RendererApi;
};
const databases: Db[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));

function harness() {
  const db = tempDb();
  databases.push(db);
  const events: AppEvent[] = [];
  let deliver: (event: AppEvent) => void = () => undefined;
  const desktop = localSpoilerHandlers(() => db, (event) => hub.broadcast(event));
  const hub = new PhoneHub({
    core: { call: async (method: string, ...params: unknown[]) => {
      if (method === 'getSetting') return getSetting(db, params[0] as string);
      if (method === 'setLocalSpoiler') return desktop.setLocalSpoiler(params[0] as string, params[1] as boolean);
      throw new Error(`Unexpected core method: ${method}`);
    } } as never,
    discord: () => ({}) as never,
    main: async () => undefined,
    media: async () => new Response(),
    active: () => true,
  });
  const { gateway } = hub.connect('companion', { broadcast: (event) => deliver(event), notify: () => undefined });
  const phone = createPhoneRendererApi({
    call: (call) => gateway.call(call.group, call.method, call.params),
    listen: (listener) => { deliver = listener; },
  });
  phone.onEvent((event) => events.push(event));
  return { db, desktop, phone, events };
}

describe('shared local spoilers', () => {
  it('reads existing desktop marks and delivers live desktop additions and removals to mobile', async () => {
    const { db, desktop, phone, events } = harness();
    setSetting(db, SETTINGS_KEYS.localSpoilers, ['existing']);
    expect(await phone.core.getSetting(SETTINGS_KEYS.localSpoilers)).toEqual(['existing']);
    desktop.setLocalSpoiler('desktop', true);
    expect(events.at(-1)).toEqual({ type: 'setting-changed', key: SETTINGS_KEYS.localSpoilers, value: ['existing', 'desktop'] });
    desktop.setLocalSpoiler('existing', false);
    expect(events.at(-1)).toEqual({ type: 'setting-changed', key: SETTINGS_KEYS.localSpoilers, value: ['desktop'] });
  });

  it('applies simultaneous device changes against current storage and lets mobile remove only its selected mark', async () => {
    const { db, desktop, phone } = harness();
    desktop.setLocalSpoiler('desktop', true);
    await Promise.all([phone.core.setLocalSpoiler('phone-one', true), phone.core.setLocalSpoiler('phone-two', true)]);
    expect(getSetting(db, SETTINGS_KEYS.localSpoilers)).toEqual(['desktop', 'phone-one', 'phone-two']);
    await phone.core.setLocalSpoiler('phone-one', false);
    expect(getSetting(db, SETTINGS_KEYS.localSpoilers)).toEqual(['desktop', 'phone-two']);
  });

  it('validates device changes and publishes nothing if storage refuses a mark', async () => {
    const { db, desktop, phone, events } = harness();
    await expect(phone.core.setLocalSpoiler('', true)).rejects.toThrow('Invalid local spoiler change');
    await expect(phone.core.setLocalSpoiler('bad', 'yes' as unknown as boolean)).rejects.toThrow('Invalid local spoiler change');
    expect(getSetting(db, SETTINGS_KEYS.localSpoilers)).toBeUndefined();
    databases.splice(databases.indexOf(db), 1);
    db.close();
    expect(() => desktop.setLocalSpoiler('failed', true)).toThrow();
    expect(events).toEqual([]);
  });
});
