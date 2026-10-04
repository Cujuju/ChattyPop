import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppEvent } from '@shared/contract';
import { PLUGIN_API_MAJOR_CHANGES, PLUGIN_API_VERSION, type PluginApi, type PluginMessage } from '@shared/plugins';
import { SETTINGS_KEYS } from '@shared/settings';
import { PluginInactiveError } from '@shared/pluginCall';
import { MIN_SCHEDULE_MS } from '../src/core/plugins/api';
import type { DecisionProvider } from '../src/core/ai/decisions';
import { setSetting, type Db } from '../src/core/db';
import { ARRIVAL } from '../src/core/arrival';
import { PluginHost } from '../src/core/plugins/host';
import { FakeJev } from './fakeJev';
import { rawMessage, seedArchive, tempDb, tempDir } from './helpers';

const MAIN = `
export function activate(api) {
  const t = api.db.table('seen');
  api.db.migrate(['CREATE TABLE ' + t + ' (id TEXT PRIMARY KEY)']);
  api.onMessage((m) => {
    api.db.prepare('INSERT INTO ' + t + ' VALUES (?)').run(m.id);
    if (m.content === 'boom') throw new Error('hook failed');
  });
  api.commands.register({ id: 'count', title: 'Count', run: () => String(api.db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n) });
}`;

let db: Db;
let dir: string;
let events: AppEvent[];
let host: PluginHost;
let jev: DecisionProvider | null;

function addPlugin(folder: string, manifest: Record<string, unknown>, main = MAIN): void {
  mkdirSync(join(dir, folder), { recursive: true });
  writeFileSync(join(dir, folder, 'plugin.json'), JSON.stringify({ version: '1.0.0', apiVersion: PLUGIN_API_VERSION, main: 'main.mjs', ...manifest }));
  writeFileSync(join(dir, folder, 'main.mjs'), main);
}
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
const status = () => Object.fromEntries(host.list().map((p) => [p.id, [p.status, p.error]]));
const message = (id: string, content: string) => ({ id, channelId: 'c', authorId: 'u', ts: 1, content, linked: '' });
/** How a test message arrived: live, just now. */
const LIVE = { via: ARRIVAL.gateway, at: 1, edit: false };

beforeEach(() => {
  db = tempDb();
  dir = tempDir();
  events = [];
  jev = null;
  host = new PluginHost(dir, { db, emit: (e) => events.push(e), changed: () => {}, ai: async () => ({ text: '' }), decider: () => jev });
});

describe('plugin host', () => {
  it('loads a plugin, feeds it messages and runs its commands', async () => {
    addPlugin('good', { id: 'good' });
    await host.loadAll();
    expect(status()).toEqual({ good: ['active', null] });
    host.dispatchMessage(message('m1', 'hi'), LIVE, 'message');
    await tick();
    await expect(host.runCommand('good', 'count', { sinceTs: 0, untilTs: 1, channelIds: null })).resolves.toBe('1');
  });

  it('records a hook failure without unloading the plugin', async () => {
    addPlugin('good', { id: 'good' });
    await host.loadAll();
    host.dispatchMessage(message('m1', 'boom'), LIVE, 'message');
    await tick();
    expect(status()).toEqual({ good: ['active', 'hook failed'] });
    expect(events.some((e) => e.type === 'plugins-changed')).toBe(true);
  });

  it('refuses bad manifests, other API majors and entries outside the folder', async () => {
    addPlugin('bad-id', { id: 'Bad Id' });
    addPlugin('future', { id: 'future', apiVersion: '4.0.0' });
    addPlugin('escape', { id: 'escape', main: '../good/main.mjs' });
    await host.loadAll();
    const s = status();
    expect(s['bad-id']![0]).toBe('error');
    expect(s['future']![1]).toMatch(/plugin API 4.0.0/);
    expect(s['escape']![1]).toMatch(/inside the plugin folder/);
  });

  it('refuses a plugin written for API 2, saying what API 3 changed', async () => {
    addPlugin('old', { id: 'old', apiVersion: '2.1.0' });
    await host.loadAll();
    expect(status()['old']).toEqual([
      'error',
      `written for plugin API 2.1.0; this ChattyPop provides ${PLUGIN_API_VERSION}, where ${PLUGIN_API_MAJOR_CHANGES}. Update it for API 3 (docs/plugins.md).`,
    ]);
  });

  it('query.messages and query.channels (API 2.0) return only what privacy mode shows, in the same shape and order', async () => {
    const OPEN = '200000000000000001';
    const HIDDEN = '200000000000000002';
    const archive = seedArchive(db, [{ id: OPEN, name: 'open' }, { id: HIDDEN, name: 'hidden' }]);
    archive.ingestMessages([rawMessage(OPEN, 1_000, 'visible'), rawMessage(HIDDEN, 2_000, 'secret'), rawMessage(OPEN, 3_000, 'later')], ARRIVAL.sync);
    archive.setChannelPolicy(HIDDEN, { hideInPrivacy: true });
    addPlugin('reader', { id: 'reader' }, `
export function activate(api) {
  api.commands.register({ id: 'read', title: 'Read', run: () => JSON.stringify({ messages: api.query.messages({}), channels: api.query.channels() }) });
}`);
    await host.loadAll();
    type Read = { messages: PluginMessage[]; channels: { id: string; name: string; guildName: string; localAiOnly: boolean }[] };
    const read = async (): Promise<Read> => JSON.parse(String(await host.runCommand('reader', 'read', { sinceTs: 0, untilTs: 1, channelIds: null }))) as Read;
    const all = await read();
    expect(all.messages.map((m) => [m.channelId, m.content])).toEqual([[OPEN, 'visible'], [HIDDEN, 'secret'], [OPEN, 'later']]);
    expect(Object.keys(all.messages[0]!).sort()).toEqual(['authorId', 'channelId', 'content', 'id', 'ts']);
    expect(all.channels.map((c) => c.id).sort()).toEqual([OPEN, HIDDEN].sort());
    expect(Object.keys(all.channels[0]!).sort()).toEqual(['guildName', 'id', 'localAiOnly', 'name']);
    setSetting(db, SETTINGS_KEYS.privacyMode, true);
    const shown = await read();
    expect(shown.messages).toEqual(all.messages.filter((m) => m.channelId !== HIDDEN));
    expect(shown.channels).toEqual(all.channels.filter((c) => c.id !== HIDDEN));
  });

  it('keeps a switched-off plugin listed but inactive', async () => {
    addPlugin('good', { id: 'good' });
    await host.loadAll();
    await host.setEnabled('good', false);
    expect(status()).toEqual({ good: ['disabled', null] });
    await host.setEnabled('good', true);
    expect(status()).toEqual({ good: ['active', null] });
  });

  it('ai.decide (API 1.2) asks Jev, and refuses clearly when Jev for plugins is off', async () => {
    addPlugin('asker', { id: 'asker' }, `
export function activate(api) {
  api.commands.register({ id: 'ask', title: 'Ask', run: async () => JSON.stringify((await api.ai.decide({ state: 'hi', questions: { q: { type: 'noul', instructions: 'is it a greeting?' } }, reads: [] })).answers) });
}`);
    await host.loadAll();
    const range = { sinceTs: 0, untilTs: 1, channelIds: null };
    await expect(host.runCommand('asker', 'ask', range)).rejects.toThrow(/Let plugins ask Jev/);
    jev = new FakeJev(() => ({ q: { type: 'noul', noul: 0.9 } }));
    await expect(host.runCommand('asker', 'ask', range)).resolves.toBe('{"q":{"type":"noul","noul":0.9}}');
  });

  it('fences a plugin turned off: a queued callback never runs, and what it held writes, notifies, asks or schedules nothing', async () => {
    const held = globalThis as { lateApi?: PluginApi; lateRan?: boolean };
    addPlugin('late', { id: 'late' }, `
export function activate(api) {
  globalThis.lateApi = api;
  api.onMessage(() => { globalThis.lateRan = true; });
}`);
    await host.loadAll();
    jev = new FakeJev(() => ({}));
    host.dispatchMessage(message('m1', 'hi'), LIVE, 'message');
    await host.setEnabled('late', false);
    await tick();
    expect(held.lateRan).toBeUndefined();
    const api = held.lateApi!;
    events.length = 0;
    api.settings.set('k', 1);
    api.notify({ title: 't', body: 'b' });
    api.schedule(MIN_SCHEDULE_MS, () => undefined);
    await expect(api.ai.decide({ state: 'hi', questions: {}, reads: [] })).rejects.toBeInstanceOf(PluginInactiveError);
    expect(api.settings.get('k')).toBeUndefined();
    expect(events).toEqual([]);
    expect((jev as FakeJev).requests).toEqual([]);
    expect(host.list().find((p) => p.id === 'late')?.status).toBe('disabled');
    delete held.lateApi;
  });

  it("fences a plugin turned off from writing through the database handle it held; its reads still work", async () => {
    const held = globalThis as { heldApi?: PluginApi; heldInsert?: { run(...p: unknown[]): unknown } };
    addPlugin('held', { id: 'held' }, `
export function activate(api) {
  api.db.migrate(['CREATE TABLE ' + api.db.table('t') + ' (id TEXT)']);
  globalThis.heldApi = api;
  globalThis.heldInsert = api.db.prepare('INSERT INTO ' + api.db.table('t') + ' VALUES (?)');
}`);
    await host.loadAll();
    const api = held.heldApi!;
    const t = api.db.table('t');
    held.heldInsert!.run('before');
    await host.setEnabled('held', false);
    expect(() => held.heldInsert!.run('late')).toThrow(PluginInactiveError);
    expect(() => api.db.prepare(`INSERT INTO ${t} VALUES (?)`).run('late')).toThrow(PluginInactiveError);
    expect(() => api.db.transaction(() => api.db.prepare(`DELETE FROM ${t}`).run())).toThrow(PluginInactiveError);
    expect(() => api.db.migrate(['SELECT 1', `DROP TABLE ${t}`])).toThrow(PluginInactiveError);
    expect(api.db.prepare(`SELECT id FROM ${t}`).all()).toEqual([{ id: 'before' }]);
    delete held.heldApi;
    delete held.heldInsert;
  });
});
