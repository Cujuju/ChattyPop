import { describe, expect, expectTypeOf, it, onTestFinished, vi } from 'vitest';
import { definePlugin } from '@plugin-sdk/shared';
import { defineCorePlugin, LocalOnlyError, type CompletionEvent, type CompletionRequest, type CompletionResult, type CompletionTool, type LlmProvider, type PluginProvider } from '@plugin-sdk/core';
import { testPlugin } from '@plugin-sdk/core/testing';
import { providerDeclarations } from '@shared/aiProviders';
import { normalizeAiSettings } from '@shared/aiSettings';
import { scopedCompletion, type ScopedCompletion } from '../src/core/ai/readScope';
import { ProviderRegistry } from '../src/core/ai/registry';
import { tempDb, tempDir } from './helpers';
import { FIXTURE_PROVIDER_PLUGINS } from './fixtureProviders';

const MAX_INPUT_CHARS = 100_000;
const tool: CompletionTool = { name: 'lookup', description: 'Look up messages', parameters: { type: 'object' }, run: async () => 'found' };
const request: CompletionRequest = { system: '', prompt: 'hi', tools: [tool], maxToolCalls: 1 };
const answer = async (): Promise<CompletionResult> => ({ text: 'answer' });
const manifest = (id: string) => ({ id, name: id, version: '1', description: '' });

function registered(tools = true, complete: LlmProvider['complete'] = answer, account = false) {
  const plugin = definePlugin({ manifest: manifest('probe'), providers: [{
    id: 'probe', label: 'Probe', displayName: 'Probe', ...(tools ? { tools: true } : {}),
    ...(account ? { accounts: {}, apiKey: { placeholder: 'key' } } : {}),
  }] });
  const declarations = providerDeclarations([plugin]);
  const settings = normalizeAiSettings({ accounts: account ? [{ id: 'probe@work', auth: 'apiKey' }] : [] }, declarations);
  const registry = new ProviderRegistry(() => undefined, declarations);
  const seen: CompletionRequest[] = [];
  const raw: LlmProvider = { id: 'probe', maxInputChars: MAX_INPUT_CHARS, complete: (req) => { seen.push(req); return complete(req); }, listModels: async () => [] };
  const off = registry.register('probe', { create: () => raw, status: async () => ({ available: true, detail: '', models: [] }), checkApiKey: async () => undefined }, account ? tempDir() : undefined);
  onTestFinished(off);
  return { registry, settings, seen, off, provider: registry.get(account ? 'probe@work' : 'probe', settings) };
}

function scripted(tools: boolean, complete: LlmProvider['complete'] = answer) {
  let provider!: PluginProvider;
  const plugin = definePlugin({ manifest: manifest('consumer') });
  const host = testPlugin(defineCorePlugin(plugin, (ctx) => { provider = ctx.ai.provider('probe'); }), {
    archive: { channels: [{ id: 'open' }, { id: 'private', localOnly: true }] },
    ai: { providers: [{ id: 'probe', tools, provider: { id: 'probe', maxInputChars: MAX_INPUT_CHARS, complete, listModels: async () => [] } }] },
  });
  onTestFinished(() => host.dispose());
  return { provider, host };
}

describe('tool request admission', () => {
  it.each([false, true])('refuses tools without a declaration (account: %s)', async (account) => {
    const h = registered(false, answer, account);
    await expect(h.provider.complete(request)).rejects.toThrow("Probe can't call tools.");
    expect(h.seen).toEqual([]);
    await expect(h.provider.complete({ system: '', prompt: '' })).resolves.toEqual({ text: 'answer' });
    await expect(h.provider.complete({ ...request, tools: [] })).resolves.toEqual({ text: 'answer' });
  });

  it.each([false, true])('rejects schema with tools before dispatch (declared: %s)', async (tools) => {
    const h = registered(tools);
    await expect(h.provider.complete({ ...request, schema: {} })).rejects.toBeInstanceOf(TypeError);
    await expect(h.provider.complete({ ...request, tools: [], schema: {} })).rejects.toBeInstanceOf(TypeError);
    expect(h.seen).toEqual([]);
  });

  it.each(['', 'Lookup', '_lookup', 'look-up', 'a'.repeat(49), 'lookup\n'])('rejects invalid tool name %j', async (name) => {
    const h = registered();
    await expect(h.provider.complete({ ...request, tools: [{ ...tool, name }] })).rejects.toBeInstanceOf(TypeError);
    expect(h.seen).toEqual([]);
  });

  it('rejects duplicate names and accepts boundary-length names', async () => {
    const h = registered();
    await expect(h.provider.complete({ ...request, tools: [tool, tool] })).rejects.toThrow('Duplicate tool name');
    expect(h.seen).toEqual([]);
    await expect(h.provider.complete({ ...request, tools: [{ ...tool, name: 'a'.repeat(48) }] })).resolves.toEqual({ text: 'answer' });
  });

  it.each([undefined, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid maxToolCalls %s', async (maxToolCalls) => {
    const h = registered();
    await expect(h.provider.complete({ ...request, maxToolCalls })).rejects.toBeInstanceOf(TypeError);
    expect(h.seen).toEqual([]);
    await expect(h.provider.complete({ ...request, tools: undefined, maxToolCalls })).resolves.toEqual({ text: 'answer' });
    expect(h.seen[0]).not.toHaveProperty('maxToolCalls');
  });

  it('validates account requests and accepts the largest safe budget', async () => {
    const h = registered(true, answer, true);
    await expect(h.provider.complete({ ...request, maxToolCalls: 0 })).rejects.toBeInstanceOf(TypeError);
    await expect(h.provider.complete({ ...request, maxToolCalls: Number.MAX_SAFE_INTEGER })).resolves.toEqual({ text: 'answer' });
  });

  it('declares tools on all four host fixture providers', () => {
    expect(providerDeclarations(FIXTURE_PROVIDER_PLUGINS).map(({ id, tools }) => [id, tools])).toEqual([
      ['claude', true], ['codex', true], ['ollama', true], ['openrouter', true],
    ]);
  });
});

describe('completion lifetime', () => {
  it.each(['registration', 'request', 'plugin'] as const)('drops retained events after %s aborts', async (lifetime) => {
    const result = Promise.withResolvers<CompletionResult>();
    let captured!: CompletionRequest;
    const complete: LlmProvider['complete'] = (req) => { captured = req; return result.promise; };
    const h = lifetime === 'plugin' ? scripted(true, complete) : registered(true, complete);
    const controller = new AbortController();
    const events: CompletionEvent[] = [];
    const pending = h.provider.complete({ ...request, reads: [], signal: controller.signal, onEvent: (e) => events.push(e) });
    const emit = captured.onEvent!;
    emit({ type: 'text', delta: 'early' });
    const rejected = expect(pending).rejects.toBeInstanceOf(Error);
    if ('host' in h) await h.host.off();
    else if (lifetime === 'request') controller.abort(new Error('cancelled'));
    else h.off();
    await rejected;
    expect(captured.onEvent).toBe(emit);
    emit({ type: 'toolResult', callId: 'late', ok: true });
    captured.onEvent!({ type: 'toolResult', callId: 'late', ok: true });
    result.resolve({ text: 'late' });
    await result.promise;
    emit({ type: 'text', delta: 'late' });
    captured.onEvent!({ type: 'text', delta: 'late' });
    expect(events).toEqual([{ type: 'text', delta: 'early' }]);
  });

  it.each(['resolve', 'reject'] as const)('drops retained events after providers %s', async (settle) => {
    const result = Promise.withResolvers<CompletionResult>();
    const h = registered(true, () => result.promise);
    const onEvent = vi.fn();
    const pending = h.provider.complete({ ...request, onEvent });
    const captured = h.seen[0]!;
    const emit = captured.onEvent!;
    emit({ type: 'text', delta: 'early' });
    if (settle === 'resolve') {
      result.resolve({ text: 'early' });
      await pending;
    } else {
      result.reject(new Error('failed'));
      await expect(pending).rejects.toThrow('failed');
    }
    expect(captured.onEvent).toBe(emit);
    emit({ type: 'text', delta: 'late' });
    captured.onEvent!({ type: 'text', delta: 'late' });
    expect(onEvent).toHaveBeenCalledExactlyOnceWith({ type: 'text', delta: 'early' });
  });

  it.each(['registration', 'request', 'plugin'] as const)('fences pending and subsequent tools when %s aborts', async (lifetime) => {
    const result = Promise.withResolvers<CompletionResult>();
    const lookup = Promise.withResolvers<string>();
    let ownSignal: AbortSignal | undefined;
    let captured!: CompletionRequest;
    const run = vi.fn((_args: unknown, signal: AbortSignal) => { ownSignal = signal; return lookup.promise; });
    const complete: LlmProvider['complete'] = (req) => { captured = req; return result.promise; };
    const h = lifetime === 'plugin' ? scripted(true, complete) : registered(true, complete);
    const controller = new AbortController();
    const pending = h.provider.complete({ ...request, tools: [{ ...tool, run }], reads: [], signal: controller.signal });
    const wrapped = captured.tools![0]!;
    const running = wrapped.run({}, new AbortController().signal);
    expect(ownSignal).toBe(captured.signal);
    const pendingRejection = expect(pending).rejects.toBeInstanceOf(Error);
    const runningRejection = expect(running).rejects.toBeInstanceOf(Error);
    if ('host' in h) await h.host.off();
    else if (lifetime === 'request') controller.abort(new Error('stop'));
    else h.off();
    await pendingRejection;
    await runningRejection;
    const reason: unknown = captured.signal!.reason;
    expect(ownSignal!.aborted).toBe(true);
    expect(ownSignal!.reason).toBe(reason);
    await expect(running).rejects.toBe(reason);
    await expect(wrapped.run({}, new AbortController().signal)).rejects.toBe(reason);
    expect(run).toHaveBeenCalledTimes(1);
    lookup.resolve('late');
    result.resolve({ text: 'late' });
  });

  it('fences events and tools when an account is removed', async () => {
    const result = Promise.withResolvers<CompletionResult>();
    const h = registered(true, () => result.promise, true);
    const onEvent = vi.fn();
    const pending = h.provider.complete({ ...request, onEvent });
    const captured = h.seen[0]!;
    const emit = captured.onEvent!;
    const rejected = expect(pending).rejects.toBeInstanceOf(Error);
    await h.registry.accountsChanged({ ...h.settings, accounts: [] });
    await rejected;
    emit({ type: 'text', delta: 'late' });
    captured.onEvent!({ type: 'text', delta: 'late' });
    await expect(captured.tools![0]!.run({}, new AbortController().signal)).rejects.toBe(captured.signal!.reason);
    expect(onEvent).not.toHaveBeenCalled();
    result.resolve({ text: 'late' });
  });

  it('never dispatches an already aborted request', async () => {
    const h = registered();
    const reason = new Error('cancelled');
    await expect(h.provider.complete({ ...request, signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(h.seen).toEqual([]);
  });
});

describe('answer text events', () => {
  it('emits an empty plain result as one text event', async () => {
    const h = registered(true, async () => ({ text: '' }));
    const onEvent = vi.fn();
    await h.provider.complete({ system: '', prompt: '', onEvent });
    expect(onEvent).toHaveBeenCalledExactlyOnceWith({ type: 'text', delta: '' });
  });
  it('emits the whole answer after non-text events, before resolving, even through nested wrappers', async () => {
    const events: CompletionEvent[] = [];
    const h = scripted(true, async (req) => {
      req.onEvent?.({ type: 'toolResult', callId: 'lookup', ok: true });
      return { text: 'answer' };
    });
    await h.provider.complete({ ...request, reads: [], onEvent: (e) => events.push(e) }).then(() => {
      expect(events).toEqual([{ type: 'toolResult', callId: 'lookup', ok: true }, { type: 'text', delta: 'answer' }]);
    });
  });

  it.each(['schema', 'streamed', 'no callback'] as const)('adds no fallback for %s requests', async (mode) => {
    const onEvent = vi.fn();
    const h = registered(true, async (req) => {
      if (mode === 'streamed') req.onEvent?.({ type: 'text', delta: 'answer' });
      return { text: 'answer', ...(mode === 'schema' ? { json: {} } : {}) };
    });
    await h.provider.complete({ system: '', prompt: '', ...(mode === 'schema' ? { schema: {} } : {}), ...(mode !== 'no callback' ? { onEvent } : {}) });
    if (mode === 'streamed') expect(onEvent).toHaveBeenCalledExactlyOnceWith({ type: 'text', delta: 'answer' });
    else expect(onEvent).not.toHaveBeenCalled();
    if (mode === 'no callback') expect(h.seen[0]).not.toHaveProperty('onEvent');
    else {
      h.seen[0]!.onEvent!({ type: 'text', delta: 'late' });
      expect(onEvent).toHaveBeenCalledTimes(mode === 'streamed' ? 1 : 0);
    }
  });
});

describe('plugin adapters', () => {
  it.each([false, true])('keeps scripted providers tools declaration (%s)', async (tools) => {
    const complete = vi.fn(answer);
    const h = scripted(tools, complete);
    const pending = h.provider.complete({ ...request, reads: [] });
    if (tools) await expect(pending).resolves.toEqual({ text: 'answer' });
    else await expect(pending).rejects.toThrow("probe can't call tools.");
    expect(complete).toHaveBeenCalledTimes(tools ? 1 : 0);
  });

  it('refuses hosted tools a local-only channel before invoking providers or tools', async () => {
    const complete = vi.fn(answer);
    const run = vi.fn(tool.run);
    const h = scripted(true, complete);
    await expect(h.provider.complete({ ...request, tools: [{ ...tool, run }], reads: ['private'] })).rejects.toBeInstanceOf(LocalOnlyError);
    expect(complete).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    await expect(h.provider.complete({ ...request, reads: ['open'] })).resolves.toEqual({ text: 'answer' });
  });

  it('omits chat fields from folder types and strips JavaScript additions at dispatch', async () => {
    type Folder = Parameters<ScopedCompletion>[0];
    expectTypeOf<Folder>().not.toHaveProperty('history');
    expectTypeOf<Folder>().not.toHaveProperty('tools');
    expectTypeOf<Folder>().not.toHaveProperty('maxToolCalls');
    expectTypeOf<Folder>().not.toHaveProperty('onEvent');
    const h = registered(false);
    const db = tempDb();
    onTestFinished(() => { db.close(); });
    const complete = scopedCompletion(() => db, h.registry, () => ({ ...h.settings, providers: { probe: { ...h.settings.providers.probe!, enabled: true } } }));
    const onEvent = vi.fn();
    const javascriptRequest = { ...request, provider: 'probe', reads: [], schema: {}, history: [{ role: 'user', text: 'earlier' }], maxToolCalls: 0, onEvent };
    await expect(complete(javascriptRequest)).resolves.toEqual({ text: 'answer', json: undefined });
    for (const field of ['history', 'tools', 'maxToolCalls', 'onEvent']) expect(h.seen[0]).not.toHaveProperty(field);
    expect(h.seen[0]).toMatchObject({ prompt: 'hi', schema: {} });
    expect(onEvent).not.toHaveBeenCalled();
  });
});
