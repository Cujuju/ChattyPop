// The owner as their next message's author (a pending send shows it): the open channel's only, never the last channel's
// while this one's loads, and kept shown while names change and it is read again.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// Uses Solid's browser runtime so resources load as in a window.
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
vi.mock('solid-js/store', () => createRequire(import.meta.url)('solid-js/store/dist/store.cjs') as Record<string, unknown>);
const { createRoot, createSignal } = createRequire(import.meta.url)('solid-js/dist/solid.cjs') as typeof import('solid-js');

interface Author { id: string; name: string }
/** Author reads by channel, each answered by the test. */
const reads = new Map<string, ((a: Author) => void)[]>();
const [names, setNames] = createSignal(0);
vi.mock('@/api', () => ({ api: { core: { ownAuthor: (channelId: string) => new Promise((answer) => reads.set(channelId, [...(reads.get(channelId) ?? []), answer])) } } }));
vi.mock('../src/renderer/src/state/events', () => ({ createPushedValue: () => ({ value: () => '900000000000000001' }), onAppEvent: () => () => undefined }));
vi.mock('../src/renderer/src/state/mentions', () => ({ membersVersion: () => names() }));
vi.mock('../src/renderer/src/state/archive', () => ({ archiveChannelId: () => null, archiveState: { items: [] }, openArchive: () => undefined }));
vi.mock('../src/renderer/src/state/chat', () => ({ chatSource: () => null }));
vi.mock('../src/renderer/src/state/posting', () => ({ closeWhenLocked: () => undefined, postingUnlocked: () => true }));
vi.mock('../src/renderer/src/state/ui', () => ({ inPanelWindow: () => false }));

// A renderer module: imported by path so the node type-check doesn't follow it.
const ownMessagesPath = '../src/renderer/src/state/ownMessages';
const { createOwnAuthor } = (await import(ownMessagesPath)) as { createOwnAuthor(channelId: () => string | null): () => Author | null | undefined };

const settle = (): Promise<void> => new Promise((r) => setTimeout(r));
const [A, B] = ['200000000000000001', '200000000000000002'];
const answer = (channelId: string, name: string): void => reads.get(channelId)!.shift()!({ id: 'me', name });

describe("the owner's author for a pending send", () => {
  it("is the open channel's, never the last one's while it loads, and stays shown while names are read again", async () => {
    const [channel, setChannel] = createSignal<string | null>(A);
    const author = createRoot(() => createOwnAuthor(channel));
    answer(A, 'Nick in A');
    await settle();
    expect(author()?.name).toBe('Nick in A');
    setNames(1);
    await settle();
    expect(author()?.name).toBe('Nick in A');
    answer(A, 'Renamed in A');
    await settle();
    expect(author()?.name).toBe('Renamed in A');
    setChannel(B);
    expect(author() ?? null).toBeNull();
    answer(B, 'Nick in B');
    await settle();
    expect(author()?.name).toBe('Nick in B');
  });
});
