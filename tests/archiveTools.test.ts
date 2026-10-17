// Archive tool contracts through fixture descriptors and the SDK's real testing host.
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { ARCHIVE_TOOL_LINES_MAX, PluginInactiveError, TOOL_NAME_PATTERN, defineCorePlugin, type ArchiveTool, type ArchiveToolResult, type ArchiveToolScope, type CoreContext } from '@plugin-sdk/core';
import { definePlugin } from '@plugin-sdk/shared';
import { testPlugin } from '@plugin-sdk/core/testing';
import { checkBundled } from '@shared/bundledCheck';
import { snowflakeFromMs } from '@shared/discord';

/** Fixture window, with messages at both inclusive edges and one outside each edge. */
const START = Date.UTC(2026, 8, 1);
const END = START + 2;
const messageId = (offset: number): string => snowflakeFromMs(START + offset);
const source = definePlugin({ manifest: { id: 'toolprobe', name: 'Tool probe', version: '1', description: '' }, aiTools: ['read'] });
const reader = definePlugin({ manifest: { id: 'readprobe', name: 'Read probe', version: '1', description: '' }, aiTools: ['own'] });
const parameters = { type: 'object', properties: {}, additionalProperties: false };
const scope: ArchiveToolScope = { channelIds: ['c1', 'c3', 'missing'], since: START, until: END };
const tool = (run: ArchiveTool['run'], name = 'read'): ArchiveTool => ({ name, description: 'Reads stored rows.', parameters, run });

function host(provide: (ctx: CoreContext<typeof source>) => void) {
  let ctx!: CoreContext<typeof source>;
  let consumer!: CoreContext<typeof reader>;
  const t = testPlugin(defineCorePlugin(source, (c) => { ctx = c; provide(c); }), {
    with: [defineCorePlugin(reader, (c) => { consumer = c; c.ai.tools.provide([tool(async () => ({ lines: [] }), 'own')]); })],
    archive: {
      guilds: [{ id: messageId(0), name: 'Open space' }, { id: messageId(1), name: 'sealed-server', hidden: true }],
      channels: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3', guildId: messageId(1), name: 'quiet-room' }],
      privacyMode: true,
      messages: [
        ...[-1, 0, 1, 2, 3].map((offset) => ({ id: messageId(offset), channelId: 'c1', ts: START + offset, content: 'stored text' })),
        { id: messageId(4), channelId: 'c2', ts: START + 4, content: 'other channel' },
        { id: messageId(5), channelId: 'c3', ts: START + 5, content: 'hidden channel' },
        { id: messageId(6), channelId: 'c1', ts: START + 6, content: 'hidden reference <#c3>' },
      ],
    },
  });
  onTestFinished(() => t.dispose());
  return { t, ctx: () => ctx, consumer, run: (s = scope, signal = new AbortController().signal) => consumer.ai.tools.run('toolprobe_read', { query: 'sample' }, s, signal) };
}
const start = (run: ArchiveTool['run']) => host((ctx) => ctx.ai.tools.provide([tool(run)]));

describe('archive tool declarations and registration', () => {
  it('requires every declared tool, including a descriptor without a core side', () => {
    const h = host(() => undefined);
    expect(h.t.status()).toEqual({ status: 'error', error: 'toolprobe declares but never registered: AI tool read' });
    expect(h.consumer.ai.tools.list()).toEqual([]);
    const t = testPlugin(source);
    onTestFinished(() => t.dispose());
    expect(t.status().error).toContain('AI tool read');
  });

  it('rejects undeclared and duplicate registrations, dropping a failed activation’s tools', () => {
    const undeclared = host((ctx) => ctx.ai.tools.provide([tool(async () => ({ lines: [] }), 'other')]));
    expect(undeclared.t.status().error).toMatch(/provides AI tool other but declares none/);
    const repeated = host((ctx) => { ctx.ai.tools.provide([tool(async () => ({ lines: [] }))]); ctx.ai.tools.provide([tool(async () => ({ lines: [] }))]); });
    expect(repeated.t.status().error).toMatch(/more than once/);
    expect(repeated.consumer.ai.tools.list()).toEqual([]);
    const batch = host((ctx) => ctx.ai.tools.provide([tool(async () => ({ lines: [] })), tool(async () => ({ lines: [] }))]));
    expect(batch.t.status().error).toMatch(/more than once/);
    expect(batch.consumer.ai.tools.list()).toEqual([]);
  });

  it('accepts valid local and qualified boundaries, rejects bad names, long qualifications and duplicates', () => {
    const descriptor = (id: string, names: readonly string[]) => ({ ...source, manifest: { ...source.manifest, id }, aiTools: names });
    expect(() => checkBundled([descriptor('a'.repeat(23), ['b'.repeat(24)])])).not.toThrow();
    for (const name of ['', 'Upper', 'has-dash', 'with.dot', '1read', 'x'.repeat(25), 'read\n']) {
      expect(() => checkBundled([descriptor('toolprobe', [name])])).toThrow(/Invalid AI tool name/);
    }
    expect(() => checkBundled([descriptor('a'.repeat(24), ['b'.repeat(24)])])).toThrow(/Invalid AI tool name/);
    expect(() => checkBundled([descriptor('has-dash', ['read'])])).toThrow(/Invalid AI tool name/);
    expect(() => checkBundled([descriptor('toolprobe', ['read', 'read'])])).toThrow(/Two bundled plugins provide AI tool/);
  });

  it('publishes qualified names in build order, excluding the caller and off plugins; metadata is copied', async () => {
    const h = start(async () => ({ lines: [] }));
    expect(h.consumer.ai.tools.list()).toEqual([{ name: 'toolprobe_read', plugin: 'toolprobe', pluginName: 'Tool probe', description: 'Reads stored rows.', parameters }]);
    expect(h.ctx().ai.tools.list().map((i) => i.name)).toEqual(['readprobe_own']);
    const info = h.consumer.ai.tools.list()[0]!;
    expect(TOOL_NAME_PATTERN.test(info.name)).toBe(true);
    info.parameters['type'] = 'string';
    expect(h.consumer.ai.tools.list()[0]!.parameters['type']).toBe('object');
    await h.t.off();
    expect(h.consumer.ai.tools.list()).toEqual([]);
    expect(h.ctx().ai.tools.list()).toEqual([]);
    await expect(h.run()).rejects.toBeInstanceOf(PluginInactiveError);
    await h.t.on();
    expect(h.consumer.ai.tools.list().map((i) => i.name)).toEqual(['toolprobe_read']);
    await expect(h.consumer.ai.tools.run('unknown_read', {}, scope, new AbortController().signal)).rejects.toThrow(/Unknown archive tool/);
  });

  it('preserves build order after reactivation and isolates separate archive hosts', async () => {
    const last = definePlugin({ ...source, manifest: { ...source.manifest, id: 'lastprobe' } });
    let consumer!: CoreContext<typeof reader>;
    const t = testPlugin(defineCorePlugin(source, (ctx) => ctx.ai.tools.provide([tool(async () => ({ lines: [] }))])), {
      with: [
        defineCorePlugin(reader, (ctx) => { consumer = ctx; ctx.ai.tools.provide([tool(async () => ({ lines: [] }), 'own')]); }),
        defineCorePlugin(last, (ctx) => ctx.ai.tools.provide([tool(async () => ({ lines: [] }))])),
      ],
    });
    onTestFinished(() => t.dispose());
    expect(consumer.ai.tools.list().map((i) => i.name)).toEqual(['toolprobe_read', 'lastprobe_read']);
    await t.off();
    expect(consumer.ai.tools.list().map((i) => i.name)).toEqual(['lastprobe_read']);
    await t.on();
    expect(consumer.ai.tools.list().map((i) => i.name)).toEqual(['toolprobe_read', 'lastprobe_read']);
    expect(start(async () => ({ lines: [] })).consumer.ai.tools.list().map((i) => i.name)).toEqual(['toolprobe_read']);
  });

  it('provides only during activation and checks object schemas, descriptions and run functions', () => {
    const h = start(async () => ({ lines: [] }));
    expect(() => h.ctx().ai.tools.provide([])).toThrow(/during activate/);
    for (const patch of [{ parameters: {} }, { parameters: { type: 'object', properties: [], additionalProperties: false } },
      { parameters: { ...parameters, properties: { query: { $ref: '#/$defs/missing' } } } }, { description: '' }, { run: null }]) {
      const bad = host((ctx) => ctx.ai.tools.provide([{ ...tool(async () => ({ lines: [] })), ...patch } as ArchiveTool]));
      expect(bad.t.status().status).toBe('error');
      expect(bad.t.status().error).toContain('AI tool read');
      expect(bad.consumer.ai.tools.list()).toEqual([]);
    }
  });
});

describe('archive tool host guards', () => {
  it('intersects channels with live privacy before invoking a tool, forwards args, and freezes scope', async () => {
    let received!: ArchiveToolScope;
    let args: unknown;
    const h = start(async (a, s) => { args = a; received = s; return { lines: [] }; });
    await h.run();
    expect(args).toEqual({ query: 'sample' });
    expect(received).toEqual({ channelIds: ['c1'], since: START, until: END });
    expect(Object.isFrozen(received)).toBe(true);
    expect(Object.isFrozen(received.channelIds)).toBe(true);
    await h.run({ ...scope, channelIds: [] });
    expect(received.channelIds).toEqual([]);
  });

  it('rejects reversed or non-finite windows before plugin code runs', async () => {
    const run = vi.fn(async () => ({ lines: [] }));
    const h = start(run);
    for (const bounds of [{ since: END, until: START }, { since: NaN, until: END }, { since: START, until: Infinity }]) {
      await expect(h.run({ ...scope, ...bounds })).rejects.toBeInstanceOf(RangeError);
    }
    expect(run).not.toHaveBeenCalled();
    await h.run({ ...scope, since: null, until: null });
    expect(run).toHaveBeenCalledOnce();
  });

  it('drops absent, out-of-scope, out-of-window and invisible message lines; keeps inclusive edges', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    onTestFinished(() => warn.mockRestore());
    const h = start(async () => ({ lines: [-1, 0, 1, 2, 3, 4, 5, 6].map((n) => ({ text: `row ${n}`, messageId: messageId(n) })).concat([{ text: 'missing', messageId: 'missing' }]) }));
    expect(await h.run()).toEqual({ lines: [0, 1, 2].map((n) => ({ text: `row ${n}`, messageId: messageId(n) })) });
    expect(warn).toHaveBeenCalledExactlyOnceWith('[plugin toolprobe] archive-tool-dropped-lines', 6);
    const all = await h.run({ ...scope, since: null, until: null });
    expect(all.lines.map((l) => l.messageId)).toEqual([-1, 0, 1, 2, 3].map(messageId));
  });

  it('filters and deduplicates readChannels and redacts both line text and notes', async () => {
    const h = start(async () => ({ lines: [{ text: '#quiet-room in sealed-server', messageId: messageId(1) }, { text: 'Totals from quiet-room' }], readChannels: ['c1', 'c1'], note: 'quiet-room / sealed-server' }));
    expect(await h.run()).toEqual({ lines: [{ text: '#private-channel in a private server', messageId: messageId(1) }, { text: 'Totals from #private-channel' }], readChannels: ['c1'], note: '#private-channel / a private server' });
  });

  it.each([undefined, [], ['c1', 'c2'], ['c1', 7]])('drops uncited content and plugin notes without complete visible provenance: %j', async (readChannels) => {
    const h = start(async () => ({ lines: [{ text: 'secretword: 42' }, { text: 'Cited fact', messageId: messageId(1) }],
      readChannels, note: 'secretword note' } as ArchiveToolResult));
    const result = await h.run();
    expect(result.lines).toEqual([{ text: 'Cited fact', messageId: messageId(1) }]);
    expect(result.note).toBeUndefined();
    expect(result.readChannels).toEqual(readChannels === undefined ? undefined : readChannels.length ? ['c1'] : []);
  });

  it('drops non-string text and malformed lines, caps output, appends a note and logs once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    onTestFinished(() => warn.mockRestore());
    const h = start(async () => ({ lines: [null, { text: 7 }, { text: 'bad id', messageId: 7 }, ...Array.from({ length: ARCHIVE_TOOL_LINES_MAX + 2 }, (_, n) => ({ text: `row ${n}` }))], readChannels: ['c1'], note: 'Existing note.' } as unknown as ArchiveToolResult));
    const result = await h.run();
    expect(result.lines).toHaveLength(ARCHIVE_TOOL_LINES_MAX);
    expect(result.lines[0]).toEqual({ text: 'row 0' });
    expect(result.note).toBe('Existing note.\nMore results not shown.');
    expect(warn).toHaveBeenCalledExactlyOnceWith('[plugin toolprobe] archive-tool-dropped-lines', 5);
  });

  it('records throws and rejects with the plugin’s own message', async () => {
    const h = start(() => { throw new Error('Tool read failed.'); });
    await expect(h.run()).rejects.toThrow('Tool read failed.');
    expect(h.t.status().error).toBe('Tool read failed.');
  });

  it('rejects malformed result envelopes and records the failure', async () => {
    const h = start(async () => null as unknown as ArchiveToolResult);
    await expect(h.run()).rejects.toThrow('An archive tool must return lines.');
    expect(h.t.status().error).toBe('An archive tool must return lines.');
  });

  it('rejects immediately on abort with its reason even when the tool ignores cancellation', async () => {
    let received!: AbortSignal;
    let finish!: (result: ArchiveToolResult) => void;
    const h = start((_a, _s, signal) => { received = signal; return new Promise((resolve) => { finish = resolve; }); });
    const controller = new AbortController();
    const pending = h.run(scope, controller.signal);
    const reason = new Error('Stopped by caller.');
    const rejected = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    await rejected;
    expect(received.aborted).toBe(true);
    finish({ lines: [{ text: 'late' }] });
    expect(h.t.status().error).toBeNull();
    await expect(h.run(scope, controller.signal)).rejects.toBe(reason);
  });

  it('fences a pending run to its contributing activation, including an off/on cycle', async () => {
    let received!: AbortSignal;
    let finish!: (result: ArchiveToolResult) => void;
    const h = start((_a, _s, signal) => { received = signal; return new Promise((resolve) => { finish = resolve; }); });
    const pending = h.run();
    const rejected = expect(pending).rejects.toBeInstanceOf(PluginInactiveError);
    await h.t.off();
    await rejected;
    expect(received.aborted).toBe(true);
    await h.t.on();
    finish({ lines: [{ text: 'old result' }] });
    expect(h.t.status().error).toBeNull();
  });

  it('rechecks message visibility if privacy changes while a run is pending', async () => {
    let finish!: (result: ArchiveToolResult) => void;
    const h = start(() => new Promise((resolve) => { finish = resolve; }));
    const pending = h.run();
    h.t.archive.setChannel('c1', { hidden: true });
    finish({ lines: [{ text: 'now hidden', messageId: messageId(1) }, { text: 'secretword: 42' }], readChannels: ['c1'], note: 'secretword note' });
    expect(await pending).toEqual({ lines: [], readChannels: [] });
  });

  it('forwards caller deactivation to a running tool and rejects with PluginInactiveError', async () => {
    let consumer!: CoreContext<typeof reader>;
    let received!: AbortSignal;
    let finish!: (result: ArchiveToolResult) => void;
    const t = testPlugin(defineCorePlugin(reader, (ctx) => { consumer = ctx; ctx.ai.tools.provide([tool(async () => ({ lines: [] }), 'own')]); }), {
      with: [defineCorePlugin(source, (ctx) => ctx.ai.tools.provide([tool((_args, _scope, signal) => {
        received = signal;
        return new Promise((resolve) => { finish = resolve; });
      })]))],
    });
    onTestFinished(() => t.dispose());
    const pending = consumer.ai.tools.run('toolprobe_read', {}, { channelIds: [], since: null, until: null }, new AbortController().signal);
    const rejected = expect(pending).rejects.toBeInstanceOf(PluginInactiveError);
    await t.off();
    await rejected;
    expect(received.aborted).toBe(true);
    finish({ lines: [] });
    await expect(consumer.ai.tools.run('toolprobe_read', {}, scope, new AbortController().signal)).rejects.toBeInstanceOf(PluginInactiveError);
  });
});
