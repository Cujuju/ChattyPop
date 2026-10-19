import { randomUUID } from 'node:crypto';
import { describe, expect, it, onTestFinished } from 'vitest';
import { defineChannels, definePlugin } from '@plugin-sdk/shared';
import { defineCorePlugin, type CoreContext } from '@plugin-sdk/core';
import { testPlugin } from '@plugin-sdk/core/testing';
import { corePort } from '../src/plugin-sdk/shared/testing/ports';
import { pluginCalls } from '../src/core/plugins/callContext';

const probe = definePlugin({
  manifest: { id: 'readcalls', name: 'Read calls', version: '1', description: '' },
  channels: defineChannels<{ core: { scan(sql: string): { value: number }[]; sync(kind: string): unknown } }>()({ core: {
    scan: { audiences: ['renderer', 'phone'], reads: true, writes: false },
    sync: { audiences: ['renderer'], reads: true },
  } }),
});
/** Native work remains active until the test cancels it, independently of machine speed. */
const HEAVY = 'WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x < 1000000000) SELECT sum(x) FROM n';

function start() {
  let context!: CoreContext<typeof probe>;
  const calls: { priority: string; signal: AbortSignal }[] = [];
  const t = testPlugin(defineCorePlugin(probe, (ctx) => {
    context = ctx;
    const prepared = ctx.storage.db.prepare('SELECT 1 AS value');
    ctx.channels.serve({
      scan: async (sql) => { await Promise.resolve(); calls.push(ctx.channels.call()); return ctx.storage.read<{ value: number }>(sql); },
      sync: async (kind) => {
        await Promise.resolve();
        if (kind === 'iterate') return [...prepared.iterate()];
        return prepared.get();
      },
    });
  }), { archive: { channels: [{ id: 'c' }], messages: [{ channelId: 'c', content: 'hello' }] } });
  onTestFinished(() => t.dispose());
  return { t, context, calls, port: corePort(t.link) };
}

describe('served read execution', () => {
  it('answers messagePage and directory while a plugin aggregation is still running', async () => {
    const { t, port, calls } = start();
    const id = randomUUID();
    const aggregate = port.call('pluginCall', 'renderer', 'readcalls', 'scan', [HEAVY], { id, priority: 'background' });
    const result = aggregate.catch((error: unknown) => error);
    let ended = false;
    void result.then(() => { ended = true; });
    await Promise.resolve();
    const page = await port.call('messagePage', { channelId: 'c', limit: 10 });
    const directory = await port.call('directory');
    expect(page).toBeTruthy();
    expect(directory).toBeTruthy();
    expect(ended).toBe(false);
    expect(calls[0]!.priority).toBe('background');
    await port.call('cancelPluginCall', 'renderer', 'readcalls', id);
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(await result).toBeInstanceOf(Error);
    expect(await t.read('SELECT 7 AS value')).toEqual([{ value: 7 }]);
  });

  it('enforces reads after awaits and on statements prepared before the call', async () => {
    const { t, context } = start();
    for (const kind of ['get', 'iterate']) await expect(t.client('renderer').sync(kind)).rejects.toThrow('plugin-sync-read: readcalls.sync');
    expect(() => context.channels.call()).toThrow('requires a served core call');
  });

  it('records plugin/member diagnostics in production mode without throwing', async () => {
    const { context } = start();
    const diagnostics: unknown[] = [];
    await pluginCalls.run({ plugin: 'readcalls', member: 'sync', reads: true, strict: false,
      signal: new AbortController().signal, priority: 'interactive', diag: (...args) => diagnostics.push(args) }, async () => {
      await Promise.resolve();
      expect(context.storage.db.prepare('SELECT 1').get()).toBeTruthy();
    });
    expect(diagnostics).toEqual([['plugin-sync-read', { plugin: 'readcalls', member: 'sync' }]]);
  });

  it('cancels phone work even when cancel arrives before its HTTP call', async () => {
    const { port, calls } = start();
    const id = randomUUID();
    await port.phone({ group: 'plugins', method: 'cancelCore', params: ['readcalls', id] });
    await expect(port.phone({ group: 'plugins', method: 'callCore', params: ['readcalls', 'scan', [HEAVY], { id, priority: 'interactive' }] })).rejects.toThrow('cancelled');
    expect(calls).toEqual([]);
  });
});
