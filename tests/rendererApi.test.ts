// Renderer stores access transport through @/api, supporting either store initialization or transport installation first.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Uses Solid’s browser runtime so reactive state runs as in a window.
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
// Its client stores too: proxies, as a window's are.
vi.mock('solid-js/store', () => createRequire(import.meta.url)('solid-js/store/dist/store.cjs') as Record<string, unknown>);

type Listener = (e: { type: string; [k: string]: unknown }) => void;
type Api = {
  core: Record<string, (...args: unknown[]) => unknown>;
  discord: Record<string, (...args: unknown[]) => unknown>;
  onEvent(listener: Listener): () => void;
};
/** A transport's API that records what reaches it. */
function transport(): Api & { calls: string[]; listeners: Set<Listener>; emit: Listener } {
  const calls: string[] = [];
  const listeners = new Set<Listener>();
  return {
    calls,
    listeners,
    emit: (e) => listeners.forEach((l) => l(e)),
    core: {
      status: async () => (calls.push('status'), { ok: true }),
      directory: async () => (calls.push('directory'), []),
      getSetting: async (key) => (calls.push(`getSetting ${String(key)}`), null),
      jevQueryOverrides: async () => (calls.push('jevQueryOverrides'), {}),
      fails: () => {
        throw new Error('refused');
      },
    },
    discord: { openChannel: (g, c) => void calls.push(`openChannel ${String(g)} ${String(c)}`) },
    onEvent: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

// Renderer modules (DOM types): imported by path so the node type-check doesn't follow them.
const LEAF = '@/api';
const TRANSPORT = '@plugin-sdk/renderer/shell/transport';
const EVENTS = '../src/renderer/src/state/events';
const CORE = '../src/renderer/src/state/core';
/** Stores that call the API while loading and need no DOM: a subscription, resources, a captured method group. */
const STORES = [EVENTS, CORE, '../src/renderer/src/state/directory', '../src/renderer/src/state/jevQueries', '../src/plugin-sdk/renderer/settings'];

const leaf = async (): Promise<{ api: Api; installApi(api: Api): void }> => (await import(LEAF)) as never;
/** Lets awaited continuations and resource loads run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r));

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe('a page whose transport installs after host stores load', () => {
  it('loads the stores, then sends their calls and subscriptions through the transport once it installs', async () => {
    vi.stubGlobal('window', {});
    for (const store of STORES) await import(store);
    const { onAppEvent } = (await import(EVENTS)) as { onAppEvent(type: string, l: Listener): () => void };
    const { coreStatus } = (await import(CORE)) as { coreStatus(): unknown };
    const seen: unknown[] = [];
    onAppEvent('archive-changed', (e) => seen.push(e.type));
    const t = transport();
    const { installRendererApi } = (await import(TRANSPORT)) as { installRendererApi(api: Api, mediaRoot: string): void };
    installRendererApi(t, '/media/');
    await settle();
    expect(t.calls).toEqual(expect.arrayContaining(['status', 'directory', 'jevQueryOverrides']));
    expect(coreStatus()).toEqual({ ok: true });
    t.emit({ type: 'archive-changed' });
    expect(seen).toEqual(['archive-changed']);
  });
});

describe('the renderer API leaf', () => {
  it('runs calls made before the install in call order, with their results and failures', async () => {
    vi.stubGlobal('window', {});
    const { api, installApi } = await leaf();
    const status = api.core['status']!();
    const failed = api.core['fails']!();
    api.discord['openChannel']!('g', 'c');
    const directory = api.core['directory']!();
    const t = transport();
    installApi(t);
    expect(t.calls).toEqual(['status', 'openChannel g c', 'directory']);
    await expect(status).resolves.toEqual({ ok: true });
    await expect(failed).rejects.toThrow('refused');
    await expect(directory).resolves.toEqual([]);
    expect(() => installApi(transport())).toThrow(/already installed/);
  });

  it('keeps call order when a queued call makes another while the install runs', async () => {
    vi.stubGlobal('window', {});
    const { api, installApi } = await leaf();
    const t = transport();
    const first = t.core['status']!;
    t.core['status'] = () => (api.core['getSetting']!('third'), first());
    void api.core['status']!();
    void api.core['directory']!();
    installApi(t);
    expect(t.calls).toEqual(['status', 'directory', 'getSetting third']);
    // Once installed, calls run at once again.
    void api.core['directory']!();
    expect(t.calls.at(-1)).toBe('directory');
  });

  it('runs every queued call when a queued subscription fails to attach', async () => {
    const reported: unknown[] = [];
    vi.stubGlobal('window', {});
    vi.stubGlobal('reportError', (err: unknown) => void reported.push(err));
    const { api, installApi } = await leaf();
    const t = transport();
    t.onEvent = () => {
      throw new Error('no events');
    };
    api.onEvent(() => undefined);
    const status = api.core['status']!();
    installApi(t);
    await expect(status).resolves.toEqual({ ok: true });
    expect(String(reported[0])).toMatch('no events');
  });

  it('attaches subscriptions at install, and never one unsubscribed before it', async () => {
    vi.stubGlobal('window', {});
    const { api, installApi } = await leaf();
    const kept: unknown[] = [];
    const dropped: unknown[] = [];
    const offKept = api.onEvent((e) => kept.push(e.type));
    api.onEvent((e) => dropped.push(e.type))();
    const t = transport();
    installApi(t);
    t.emit({ type: 'a' });
    offKept();
    t.emit({ type: 'b' });
    expect(kept).toEqual(['a']);
    expect(dropped).toEqual([]);
    expect(t.listeners.size).toBe(0);
  });

  it('uses the preload’s API at once in the app’s windows', async () => {
    const t = transport();
    vi.stubGlobal('window', { chattypop: t });
    const { api } = await leaf();
    api.discord['openChannel']!('g', 'c');
    expect(t.calls).toEqual(['openChannel g c']);
    const off = api.onEvent(() => undefined);
    expect(t.listeners.size).toBe(1);
    off();
    expect(t.listeners.size).toBe(0);
  });

  it('sends store data as plain data, which IPC can clone', async () => {
    const t = transport();
    const sent: unknown[] = [];
    // The preload's ipcRenderer.invoke structured-clones its arguments, throwing on a proxy.
    t.discord['react'] = (...args) => void sent.push(structuredClone(args));
    vi.stubGlobal('window', { chattypop: t });
    const { api } = await leaf();
    const { createStore } = await import('solid-js/store');
    const [message] = createStore({ reactions: [{ emoji: { id: '1', name: 'qthis', animated: false } }] });
    const emoji = message.reactions[0]!.emoji;
    expect(() => structuredClone(emoji)).toThrow();
    api.discord['react']!({ messageId: 'm', emoji, add: false });
    expect(sent).toEqual([[{ messageId: 'm', emoji: { id: '1', name: 'qthis', animated: false }, add: false }]]);
  });
});

describe('host renderer code', () => {
  const ROOT = resolve(import.meta.dirname, '..');
  const LEAF_FILE = join(ROOT, 'src/renderer/src/api.ts');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) ? [p] : [];
    });

  it('reaches the renderer API only through @/api, never the preload’s global', () => {
    // Comments dropped: they may name the global.
    const code = (file: string): string => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    const offenders = ['src/renderer', 'src/plugin-sdk']
      .flatMap((d) => files(join(ROOT, d)))
      .filter((f) => f !== LEAF_FILE && /\.\s*chattypop\b|\[\s*['"`]chattypop['"`]\s*\]/.test(code(f)))
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});
