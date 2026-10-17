import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { definePlugin } from '@plugin-sdk/shared';
import { defineCorePlugin, LocalOnlyError, toolRunner, type CompletionRequest, type CompletionTool, type LlmProvider, type PluginProvider } from '@plugin-sdk/core';
import { testPlugin } from '@plugin-sdk/core/testing';

const MAX_INPUT_CHARS = 100_000;
const tool: CompletionTool = { name: 'lookup', description: 'Read messages', parameters: {}, run: async () => 'archive content' };
const request = { system: '', prompt: 'hi', tools: [tool], maxToolCalls: 1 };
const scopes = [{ reads: ['open'] }, { reads: 'all' }] as const;

function scripted(complete: LlmProvider['complete'], local = false) {
  let provider!: PluginProvider;
  const plugin = definePlugin({ manifest: { id: 'consumer', name: 'Consumer', version: '1', description: '' } });
  const host = testPlugin(defineCorePlugin(plugin, (ctx) => { provider = ctx.ai.provider('probe'); }), {
    archive: { channels: [{ id: 'open' }] },
    ai: { providers: [{ id: 'probe', tools: true, local, provider: { id: 'probe', maxInputChars: MAX_INPUT_CHARS, complete, listModels: async () => [] } }] },
  });
  onTestFinished(() => host.dispose());
  return { provider, host };
}

describe('tool read policy changes', () => {
  it.each(scopes)('refuses reads $reads before a tool runs even if the provider swallows the refusal', async ({ reads }) => {
    const proceed = Promise.withResolvers<void>();
    const delivered = vi.fn();
    const run = vi.fn(tool.run);
    let captured!: CompletionRequest;
    const complete = vi.fn(async (req: CompletionRequest) => {
      captured = req;
      await proceed.promise;
      try {
        delivered(await req.tools![0]!.run({}, req.signal!));
      } catch { /* Providers may swallow tool failures. */ }
      req.onEvent!({ type: 'text', delta: 'late' });
      return { text: 'ignored refusal' };
    });
    const h = scripted(complete);
    const onEvent = vi.fn();
    const pending = h.provider.complete({ ...request, tools: [{ ...tool, run }], reads, onEvent });
    h.host.archive.setChannel('open', { localOnly: true });
    proceed.resolve();
    await expect(pending).rejects.toBeInstanceOf(LocalOnlyError);
    await expect(complete.mock.results[0]!.value).resolves.toEqual({ text: 'ignored refusal' });
    expect(captured.signal!.aborted).toBe(true);
    expect(captured.signal!.reason).toBeInstanceOf(LocalOnlyError);
    expect(run).not.toHaveBeenCalled();
    expect(delivered).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it.each(scopes)('withholds results for reads $reads when policy changes during a tool run', async ({ reads }) => {
    const started = Promise.withResolvers<void>();
    const lookup = Promise.withResolvers<string>();
    const delivered = vi.fn();
    const run = vi.fn((_args: unknown, signal: AbortSignal) => {
      expect(signal).toBe(captured.signal);
      started.resolve();
      return lookup.promise;
    });
    let captured!: CompletionRequest;
    const complete = vi.fn(async (req: CompletionRequest) => {
      captured = req;
      delivered(await toolRunner(req, req.signal!).call('lookup', {}, 'call'));
      return { text: 'answer' };
    });
    const h = scripted(complete);
    const onEvent = vi.fn();
    const pending = h.provider.complete({ ...request, tools: [{ ...tool, run }], reads, onEvent });
    await started.promise;
    h.host.archive.setChannel('open', { localOnly: true });
    lookup.resolve('archive content');
    await expect(pending).rejects.toBeInstanceOf(LocalOnlyError);
    await expect(complete.mock.results[0]!.value).rejects.toBe(captured.signal!.reason);
    expect(captured.signal!.aborted).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(delivered).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledExactlyOnceWith({ type: 'toolCall', callId: 'call', name: 'lookup', args: {} });
  });

  it('withholds a tool failure when policy changes while it runs', async () => {
    const started = Promise.withResolvers<void>();
    const lookup = Promise.withResolvers<string>();
    const delivered = vi.fn();
    const complete = vi.fn(async (req: CompletionRequest) => {
      delivered(await toolRunner(req, req.signal!).call('lookup', {}, 'call'));
      return { text: 'answer' };
    });
    const h = scripted(complete);
    const pending = h.provider.complete({ ...request, reads: ['open'], tools: [{ ...tool, run: () => { started.resolve(); return lookup.promise; } }] });
    await started.promise;
    h.host.archive.setChannel('open', { localOnly: true });
    lookup.reject(new Error('archive content'));
    await expect(pending).rejects.toBeInstanceOf(LocalOnlyError);
    await expect(complete.mock.results[0]!.value).rejects.toBeInstanceOf(LocalOnlyError);
    expect(delivered).not.toHaveBeenCalled();
  });

  it.each(['before', 'during'])('allows local tool reads when policy changes %s the run', async (timing) => {
    const proceed = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const lookup = Promise.withResolvers<string>();
    let captured!: CompletionRequest;
    const h = scripted(async (req) => {
      captured = req;
      await proceed.promise;
      const result = await toolRunner(req, req.signal!).call('lookup', {}, 'call');
      return { text: result.text };
    }, true);
    const pending = h.provider.complete({ ...request, reads: ['open'], tools: [{ ...tool, run: () => { started.resolve(); return lookup.promise; } }] });
    if (timing === 'before') h.host.archive.setChannel('open', { localOnly: true });
    proceed.resolve();
    await started.promise;
    if (timing === 'during') h.host.archive.setChannel('open', { localOnly: true });
    lookup.resolve('archive content');
    await expect(pending).resolves.toEqual({ text: 'archive content' });
    expect(captured.signal!.aborted).toBe(false);
  });

  it.each([{ tools: undefined }, { tools: [] }])('keeps in-flight requests with tools $tools unchanged', async ({ tools }) => {
    const result = Promise.withResolvers<{ text: string }>();
    const h = scripted(() => result.promise);
    const pending = h.provider.complete({ system: '', prompt: 'hi', reads: ['open'], tools, maxToolCalls: 1 });
    h.host.archive.setChannel('open', { localOnly: true });
    result.resolve({ text: 'answer' });
    await expect(pending).resolves.toEqual({ text: 'answer' });
  });
});
