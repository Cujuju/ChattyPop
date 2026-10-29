// A saved-message card's archive preview: only its own target's message, only while saved messages are live, and read
// again (the old one hidden at once) when privacy or the archived message changes.
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArchiveMessage } from '@shared/contract';
import type { SavedTarget } from '@shared/savedMessages';

// Uses Solid's browser runtime so resources load as in a window.
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
vi.mock('solid-js/store', () => createRequire(import.meta.url)('solid-js/store/dist/store.cjs') as Record<string, unknown>);
const { createRoot, createSignal } = createRequire(import.meta.url)('solid-js/dist/solid.cjs') as typeof import('solid-js');

/** Archive reads by message id, each answered by the test. */
const reads = new Map<string, ((m: ArchiveMessage | null) => void)[]>();
const listeners = new Map<string, () => void>();
const [state, setState] = createSignal({ session: 'S1' as string | null, stale: false, revision: 1, pageEpoch: 1 });

vi.mock('@/api', () => ({ api: { core: { messageById: (id: string) => new Promise((answer) => reads.set(id, [...(reads.get(id) ?? []), answer])) } } }));
vi.mock('../src/renderer/src/state/events', () => ({
  onAppEvent: (type: string, fn: () => void) => { listeners.set(type, fn); return () => undefined; },
  onArchiveChange: (_filter: unknown, fn: () => void) => { listeners.set('archive', fn); return () => undefined; },
  onMessagePartsChanged: (fn: (ids: string[] | null) => void) => { listeners.set('parts', () => fn(null)); return () => undefined; },
}));
vi.mock('../src/renderer/src/state/savedMessages', () => ({ savedMessages: () => state() }));

// A renderer module: imported by path so the node type-check doesn't follow it.
const previewsPath = '../src/renderer/src/state/savedMessagePreviews';
const { createSavedMessagePreview } = (await import(previewsPath)) as { createSavedMessagePreview(target: () => SavedTarget): () => ArchiveMessage | null };

/** Each test's previews, disposed after it so they stop reading. */
const disposers: (() => void)[] = [];
const settle = (): Promise<void> => new Promise((r) => setTimeout(r));
const CHANNEL = '100000000000000001';
const message = (id: string, text: string, channelId = CHANNEL): ArchiveMessage => ({ id, channelId, content: text }) as ArchiveMessage;
const answer = (id: string, m: ArchiveMessage | null): void => reads.get(id)!.shift()!(m);
const target = (messageId: string): SavedTarget => ({ channelId: CHANNEL, messageId }) as SavedTarget;

function harness(first = 'M1') {
  const [row, setRow] = createSignal(target(first));
  const preview = createRoot((dispose) => { disposers.push(dispose); return createSavedMessagePreview(row); });
  return { preview, setRow };
}

describe("a saved message's preview", () => {
  afterEach(() => disposers.splice(0).forEach((dispose) => dispose()));
  beforeEach(() => {
    reads.clear();
    listeners.clear();
    setState({ session: 'S1', stale: false, revision: 1, pageEpoch: 1 });
  });

  it("shows its target's archived message, never one from another channel", async () => {
    const h = harness();
    expect(h.preview()).toBeNull();
    answer('M1', message('M1', 'hello'));
    await settle();
    expect(h.preview()?.content).toBe('hello');
    h.setRow(target('M2'));
    expect(h.preview()).toBeNull();
    answer('M2', message('M2', 'elsewhere', '100000000000000009'));
    await settle();
    expect(h.preview()).toBeNull();
  });

  it("shows nothing of the previous target's while the next loads, nor its late answer", async () => {
    const h = harness();
    h.setRow(target('M2'));
    answer('M1', message('M1', 'old'));
    await settle();
    expect(h.preview()).toBeNull();
    answer('M2', message('M2', 'new'));
    await settle();
    expect(h.preview()?.content).toBe('new');
  });

  it('shows nothing without a live, current saved-message session', async () => {
    const h = harness();
    answer('M1', message('M1', 'hello'));
    await settle();
    setState((s) => ({ ...s, stale: true }));
    expect(h.preview()).toBeNull();
    setState((s) => ({ ...s, stale: false, session: null }));
    expect(h.preview()).toBeNull();
  });

  it.each(['privacy-changed', 'archive', 'parts'])('on %s, hides the old read at once and shows the new one', async (change) => {
    const h = harness();
    answer('M1', message('M1', 'before'));
    await settle();
    listeners.get(change)!();
    expect(h.preview()).toBeNull();
    answer('M1', message('M1', 'after'));
    await settle();
    expect(h.preview()?.content).toBe('after');
  });

  it('reads again when the saved list changes', async () => {
    const h = harness();
    answer('M1', message('M1', 'before'));
    await settle();
    setState((s) => ({ ...s, revision: 2 }));
    expect(h.preview()).toBeNull();
    answer('M1', message('M1', 'after'));
    await settle();
    expect(h.preview()?.content).toBe('after');
  });
});
