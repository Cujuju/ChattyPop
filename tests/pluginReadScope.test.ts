// Plugin AI requests declare channel scope, checked against the selected provider and effective local-only policy.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@plugin-sdk/shared';
import { defineCorePlugin, LocalOnlyError, type CoreContext, type LlmProvider, type ProviderImpl } from '@plugin-sdk/core';
import { PLUGIN_API_VERSION } from '@shared/plugins';
import { setSetting, type Db } from '../src/core/db';
import type { Archive } from '../src/core/archive';
import { JevProvider, type JevRoute } from '../src/core/ai/jev';
import { scopedDecider } from '../src/core/ai/readScope';
import { ARRIVAL } from '../src/core/arrival';
import { FakeJev } from './fakeJev';
import { rawMessage, seedArchive, tempDb, tempDir } from './helpers';
import { startProviders } from './providerHost';

const OPEN = '200000000000000001';
const PRIVATE = '200000000000000002';
/** A thread under PRIVATE with no policy of its own: it inherits local AI only. */
const THREAD = '200000000000000003';
/** Discord's public-thread channel type. */
const PUBLIC_THREAD = 11;

const probe = definePlugin({
  manifest: { id: 'probe', name: 'Probe', version: '1', description: '' },
  providers: [
    { id: 'probe', label: 'Probe', displayName: 'Probe', enabledByDefault: true },
    { id: 'probe.local', label: 'Probe · local', displayName: 'Local probe', enabledByDefault: true, local: true },
  ],
});

/** Prompts each provider was sent, by provider id. */
let sent: string[];
let ctx: CoreContext<typeof probe>;
let jev: FakeJev;
let db: Db;
let archive: Archive;
let pluginsDir: string;

const answering = (id: string): LlmProvider => ({
  id,
  maxInputChars: 1_000,
  complete: async (req) => {
    sent.push(`${id}:${req.prompt}`);
    return { text: id };
  },
  listModels: async () => [],
});
const impl = (id: string): ProviderImpl => ({ create: () => answering(id), status: async () => ({ available: true, detail: '', models: [] }) });

/** Starts the probe over `db` with both its providers on. */
function start() {
  setSetting(db, 'ai', { providers: { probe: { enabled: true }, 'probe.local': { enabled: true } } });
  const core = defineCorePlugin(probe, (c) => {
    ctx = c;
    c.ai.registerProvider('probe', impl('probe'));
    c.ai.registerProvider('probe.local', impl('probe.local'));
  });
  return startProviders([core], [probe], db, { jev, pluginsDir });
}

afterEach(() => void vi.unstubAllGlobals());

beforeEach(() => {
  sent = [];
  jev = new FakeJev(() => ({}));
  db = tempDb();
  pluginsDir = tempDir();
  archive = seedArchive(db, [{ id: OPEN }, { id: PRIVATE }]);
  archive.upsertThreads([{ id: THREAD, name: 'side', type: PUBLIC_THREAD, parent_id: PRIVATE, last_message_id: null }], 0);
  archive.setChannelPolicy(PRIVATE, { localAiOnly: true });
});

const ask = (reads: readonly string[] | 'all') => ({ system: '', prompt: 'q', reads });
const decide = (reads: readonly string[] | 'all') => ({ state: 'hi', questions: {}, reads });

describe('a hosted provider', () => {
  it('is refused a local-only channel and a thread under one, on every request path, before anything is sent', async () => {
    start();
    for (const reads of [[PRIVATE], [THREAD], [OPEN, THREAD]]) {
      await expect(ctx.ai.provider('probe').complete(ask(reads))).rejects.toBeInstanceOf(LocalOnlyError);
      await expect(ctx.jev.decider('pluginDecide')!.decide(decide(reads))).rejects.toBeInstanceOf(LocalOnlyError);
    }
    expect(sent).toEqual([]);
    expect(jev.requests).toEqual([]);
    await expect(ctx.ai.provider('probe').complete(ask([OPEN]))).resolves.toMatchObject({ text: 'probe' });
    await ctx.jev.decider('pluginDecide')!.decide(decide([OPEN]));
    expect(jev.requests).toHaveLength(1);
  });

  it("is refused 'all' while any channel is local-only, and allowed it once none is", async () => {
    start();
    await expect(ctx.ai.provider('probe').complete(ask('all'))).rejects.toBeInstanceOf(LocalOnlyError);
    await expect(ctx.jev.decider('pluginDecide')!.decide(decide('all'))).rejects.toBeInstanceOf(LocalOnlyError);
    archive.setChannelPolicy(PRIVATE, { localAiOnly: false });
    await expect(ctx.ai.provider('probe').complete(ask('all'))).resolves.toMatchObject({ text: 'probe' });
    await expect(ctx.ai.provider('probe').complete(ask([THREAD]))).resolves.toMatchObject({ text: 'probe' });
  });
});

describe('a local provider', () => {
  it('reads local-only channels, their threads and everything', async () => {
    start();
    await expect(ctx.ai.provider('probe.local').complete(ask([PRIVATE, THREAD]))).resolves.toMatchObject({ text: 'probe.local' });
    expect(sent).toEqual(['probe.local:q']);
  });
});

describe('the check at dispatch', () => {
  it('follows the channel policy when the request is sent, not when the provider was handed out', async () => {
    start();
    const provider = ctx.ai.provider('probe');
    await expect(provider.complete(ask([OPEN]))).resolves.toMatchObject({ text: 'probe' });
    archive.setChannelPolicy(OPEN, { localAiOnly: true });
    await expect(provider.complete(ask([OPEN]))).rejects.toBeInstanceOf(LocalOnlyError);
  });

  it("refuses a Jev request still waiting for a slot once a channel it reads turns local-only, sending nothing", async () => {
    /** Jev's cap on requests in flight (jev.ts MAX_IN_FLIGHT). */
    const IN_FLIGHT = 4;
    const route: JevRoute = { label: 'test', endpoint: 'https://jev.test/decide', wireModel: 'jev', headers: {}, errorText: () => 'failed', cost: () => null };
    const replies: (() => void)[] = [];
    vi.stubGlobal('fetch', () => new Promise<Response>((resolve) => replies.push(() => resolve(new Response(JSON.stringify({ answers: {} }))))));
    const scoped = scopedDecider(new JevProvider(() => undefined).via(route), () => db);
    const asked = Array.from({ length: IN_FLIGHT + 1 }, () => scoped.decide(decide([OPEN])).then(() => 'answered', (err: unknown) => err));
    await vi.waitFor(() => expect(replies).toHaveLength(IN_FLIGHT));
    archive.setChannelPolicy(OPEN, { localAiOnly: true });
    replies[0]!();
    expect(await asked.at(-1)).toBeInstanceOf(LocalOnlyError);
    expect(await asked[0]).toBe('answered');
    expect(replies).toHaveLength(IN_FLIGHT);
  });

  it('refuses a request that declares no reads, local or hosted', async () => {
    start();
    const undeclared = { system: '', prompt: 'q' } as never;
    await expect(ctx.ai.provider('probe.local').complete(undeclared)).rejects.toBeInstanceOf(TypeError);
    await expect(ctx.jev.decider('pluginDecide')!.decide({ state: '', questions: {} } as never)).rejects.toBeInstanceOf(TypeError);
    expect(sent).toEqual([]);
  });
});

describe('source selection (ctx.ai.sources)', () => {
  it('keeps what the reader may be sent', () => {
    start();
    const ids = [OPEN, PRIVATE, THREAD];
    expect(ctx.ai.sources.permitted(ids, 'hosted')).toEqual([OPEN]);
    expect(ctx.ai.sources.permitted(ids, { provider: 'probe' })).toEqual([OPEN]);
    expect(ctx.ai.sources.permitted(ids, { provider: 'probe.local' })).toEqual(ids);
    archive.ingestMessages([rawMessage(OPEN, 1_000, 'open'), rawMessage(THREAD, 2_000, 'thread')], ARRIVAL.sync);
    const channels = (reader: Parameters<typeof ctx.ai.sources.sql>[1]) =>
      db.prepare(`SELECT channel_id FROM archive_all_messages m WHERE ${ctx.ai.sources.sql('m.channel_id', reader)} ORDER BY ts`).pluck().all();
    expect(channels('hosted')).toEqual([OPEN]);
    expect(channels({ provider: 'probe.local' })).toEqual([OPEN, THREAD]);
  });
});

describe('a folder plugin (PluginApi 3.0)', () => {
  const ASKER = `
export function activate(api) {
  const reads = (range) => range.channelIds ?? 'all';
  api.commands.register({ id: 'complete', title: 'Complete', run: async (range) => (await api.ai.complete({ provider: 'probe', system: '', prompt: 'q', reads: reads(range) })).text });
  api.commands.register({ id: 'decide', title: 'Decide', run: async (range) => JSON.stringify((await api.ai.decide({ state: 'hi', questions: {}, reads: reads(range) })).answers) });
  api.commands.register({ id: 'undeclared', title: 'Undeclared', run: async () => (await api.ai.complete({ provider: 'probe', system: '', prompt: 'q' })).text });
}`;

  it('declares reads on ai.complete and ai.decide, checked as the bundled requests are', async () => {
    mkdirSync(join(pluginsDir, 'asker'));
    writeFileSync(join(pluginsDir, 'asker', 'plugin.json'), JSON.stringify({ id: 'asker', version: '1', apiVersion: PLUGIN_API_VERSION, main: 'main.mjs' }));
    writeFileSync(join(pluginsDir, 'asker', 'main.mjs'), ASKER);
    const { host } = start();
    await host.loadAll();
    const range = (channelIds: string[] | null) => ({ sinceTs: 0, untilTs: 1, channelIds });
    await expect(host.runCommand('asker', 'complete', range([THREAD]))).rejects.toBeInstanceOf(LocalOnlyError);
    await expect(host.runCommand('asker', 'complete', range(null))).rejects.toBeInstanceOf(LocalOnlyError);
    await expect(host.runCommand('asker', 'decide', range([PRIVATE]))).rejects.toBeInstanceOf(LocalOnlyError);
    await expect(host.runCommand('asker', 'undeclared', range(null))).rejects.toBeInstanceOf(TypeError);
    expect(sent).toEqual([]);
    expect(jev.requests).toEqual([]);
    await expect(host.runCommand('asker', 'complete', range([OPEN]))).resolves.toBe('probe');
    await expect(host.runCommand('asker', 'decide', range([OPEN]))).resolves.toBe('{}');
  });
});
