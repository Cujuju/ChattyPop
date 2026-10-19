import * as processes from '../src/core/reads/helperProcess';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { defineChannels, definePlugin } from '@plugin-sdk/shared';
import { defineCorePlugin, type CoreContext } from '@plugin-sdk/core';
import { testPlugin } from '@plugin-sdk/core/testing';
import { corePort } from '../src/plugin-sdk/shared/testing/ports';
import { pluginCalls } from '../src/core/plugins/callContext';

vi.mock('../src/core/reads/helperProcess', async (original) => {
  const actual = await original<typeof import('../src/core/reads/helperProcess')>();
  return { ...actual, forkReadHelper: vi.fn(actual.forkReadHelper) };
});

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
  it('ends the call lifetime in refined contexts before detached background reads resume', async () => {
    const descriptor = definePlugin({ manifest: { id: 'callend', name: 'Call end', version: '1', description: '' },
      channels: defineChannels<{ core: { launch(): boolean } }>()({ core: { launch: { audiences: ['renderer'], reads: true } } }),
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let background!: Promise<unknown>;
    const t = testPlugin(defineCorePlugin(descriptor, (ctx) => {
      ctx.channels.serve({ launch: () => {
        background = gate.then(async () => {
          expect(() => ctx.channels.call()).toThrow('requires a served core call');
          expect(ctx.storage.db.prepare('SELECT 1 AS value').get()).toEqual({ value: 1 });
          return ctx.storage.read('SELECT 7 AS value');
        });
        void background.catch(() => undefined);
        return true;
      } });
    }));
    try {
      expect(await t.client('renderer').launch()).toBe(true);
      release();
      await expect(background).resolves.toEqual([{ value: 7 }]);
    } finally { release(); await t.dispose(); }
  });

  it('answers messagePage and directory while a plugin aggregation is still running', async () => {
    const { t, port, calls } = start();
    const fork = vi.mocked(processes.forkReadHelper).getMockImplementation()!;
    let started!: () => void;
    const workerStarted = new Promise<void>((resolve) => { started = resolve; });
    const spy = vi.spyOn(processes, 'forkReadHelper').mockImplementation((...args: Parameters<typeof fork>) => {
      const child = fork(...args);
      child.on('message', (reply: { kind: string }) => { if (reply.kind === 'started') started(); });
      return child;
    });
    onTestFinished(() => spy.mockRestore());
    const id = randomUUID();
    const aggregate = port.call('pluginCall', 'renderer', 'readcalls', 'scan', [HEAVY], { id, priority: 'background' });
    const result = aggregate.catch((error: unknown) => error);
    let ended = false;
    void result.then(() => { ended = true; });
    await workerStarted;
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
    await pluginCalls.run({ plugin: 'readcalls', member: 'sync', reads: false, strict: false,
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
