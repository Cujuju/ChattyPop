import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '@shared/contract';

vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);

const env = vi.hoisted(() => ({
  panel: false,
  companion: false,
  get: vi.fn<() => Promise<string | null>>(),
  report: vi.fn(),
  emit: (_e: AppEvent) => {},
  source: (): 'archive' | 'live' => 'archive',
  setSource: (_value: 'archive' | 'live') => {},
}));
vi.mock('@/api', () => ({ api: {
  core: { messagePage: vi.fn() },
  discord: { shownChannel: async () => null },
  getShownChannel: env.get,
  reportShownChannel: env.report,
  onEvent: (listener: (e: AppEvent) => void) => {
    env.emit = listener;
    return () => {};
  },
} }));
vi.mock('../src/renderer/src/state/ui', () => ({
  get inPanelWindow() { return env.panel; },
  get inCompanion() { return env.companion; },
}));
vi.mock('../src/renderer/src/state/directory', () => ({ channelById: () => ({}), refetchDirectory: async () => {} }));
vi.mock('../src/renderer/src/state/chat', () => ({
  chatSource: () => env.source(),
  setChatSource: (value: 'archive' | 'live') => env.setSource(value),
}));
vi.mock('@plugin-sdk/renderer/settings', async () => {
  const { createSignal } = await import('solid-js');
  return { createSetting: (_key: string, initial: unknown) => [...createSignal(initial), { loaded: Promise.resolve() }] };
});

const CHANNEL = '200000000000000001';
const NEXT_CHANNEL = '200000000000000002';
// Variable paths keep renderer modules out of the node type-check.
const ARCHIVE = '../src/renderer/src/state/archive';
const CHAT = '../src/renderer/src/state/chat';
interface Archive {
  shownChannelId(): string | null;
  setArchiveChannelId(value: string | null): void;
  setLiveChannelId(value: string | null): void;
}
const load = async (): Promise<Archive> => await import(ARCHIVE) as Archive;
const settle = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

beforeEach(async () => {
  vi.resetModules();
  const { createSignal } = await import('solid-js');
  [env.source, env.setSource] = createSignal<'archive' | 'live'>('archive');
  env.panel = false;
  env.companion = false;
  env.get.mockReset().mockResolvedValue(CHANNEL);
  env.report.mockClear();
});

describe('shownChannelId in a panel window', () => {
  it('reads the main window channel and follows pushes, including null, regardless of local state', async () => {
    env.panel = true;
    const archive = await load();
    await settle();
    expect(env.get).toHaveBeenCalledOnce();
    expect(archive.shownChannelId()).toBe(CHANNEL);
    archive.setArchiveChannelId('local-archive');
    archive.setLiveChannelId('local-live');
    const { setChatSource } = await import(CHAT);
    setChatSource('live');
    expect(archive.shownChannelId()).toBe(CHANNEL);
    env.emit({ type: 'shown-channel', channelId: NEXT_CHANNEL });
    expect(archive.shownChannelId()).toBe(NEXT_CHANNEL);
    env.emit({ type: 'shown-channel', channelId: null });
    expect(archive.shownChannelId()).toBeNull();
    expect(env.report).not.toHaveBeenCalled();
  });

  it.each([NEXT_CHANNEL, null])('keeps a newer push (%s) when the initial read completes later', async (channelId) => {
    env.panel = true;
    let resolve!: (value: string | null) => void;
    env.get.mockReturnValue(new Promise((done) => { resolve = done; }));
    const archive = await load();
    env.emit({ type: 'shown-channel', channelId });
    resolve(CHANNEL);
    await settle();
    expect(archive.shownChannelId()).toBe(channelId);
  });

  it('keeps receiving updates after a failed initial read', async () => {
    env.panel = true;
    env.get.mockRejectedValue(new Error('disconnected'));
    const archive = await load();
    await settle();
    expect(archive.shownChannelId()).toBeNull();
    env.emit({ type: 'shown-channel', channelId: CHANNEL });
    expect(archive.shownChannelId()).toBe(CHANNEL);
  });
});

describe('shownChannelId outside a panel window', () => {
  it('preserves main-window live and archive selection and reports each shown change', async () => {
    const archive = await load();
    const { setChatSource } = await import(CHAT);
    expect(archive.shownChannelId()).toBeNull();
    archive.setArchiveChannelId(CHANNEL);
    expect(archive.shownChannelId()).toBe(CHANNEL);
    expect(env.report).toHaveBeenLastCalledWith(CHANNEL);
    archive.setLiveChannelId(NEXT_CHANNEL);
    expect(archive.shownChannelId()).toBe(CHANNEL);
    setChatSource('live');
    expect(archive.shownChannelId()).toBe(NEXT_CHANNEL);
    expect(env.report).toHaveBeenLastCalledWith(NEXT_CHANNEL);
    env.emit({ type: 'shown-channel', channelId: 'ignored-mirror' });
    expect(archive.shownChannelId()).toBe(NEXT_CHANNEL);
    setChatSource('archive');
    archive.setArchiveChannelId(null);
    expect(env.report.mock.calls).toEqual([[null], [CHANNEL], [NEXT_CHANNEL], [CHANNEL], [null]]);
    expect(env.get).not.toHaveBeenCalled();
  });

  it('keeps the companion selection local and never reports it', async () => {
    env.companion = true;
    const archive = await load();
    archive.setArchiveChannelId(CHANNEL);
    env.emit({ type: 'shown-channel', channelId: NEXT_CHANNEL });
    expect(archive.shownChannelId()).toBe(CHANNEL);
    expect(env.report).not.toHaveBeenCalled();
    expect(env.get).not.toHaveBeenCalled();
  });
});
