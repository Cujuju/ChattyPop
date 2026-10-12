import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type { ArchiveEmoji, ArchiveMessage } from '@shared/contract';
import type { UsedEmoji } from '@shared/compose';

vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
vi.mock('@/api', () => ({ api: {} }));
vi.mock('@/state/archive', () => ({ refreshLoaded: vi.fn() }));
vi.mock('@/state/dialogs', () => ({ failureNotice: vi.fn() }));
vi.mock('@/state/events', () => ({ onAppEvent: vi.fn() }));

// Keep renderer aliases out of the node type-check, as in other renderer-store tests.
const reactionsPath = '../src/renderer/src/state/reactions';
const { asReaction, reactedWith } = await import(reactionsPath) as {
  asReaction(emoji: UsedEmoji): ArchiveEmoji;
  reactedWith(message: ArchiveMessage, emoji: ArchiveEmoji): boolean;
};

describe('Unicode reaction picks', () => {
  it('recognizes a picked star as the existing owner reaction', () => {
    const picked = asReaction({ unicode: '⭐\uFE0F' });
    expect(picked).toEqual({ id: null, name: '⭐', animated: false });
    const message = { reactions: [{ emoji: { id: null, name: '⭐', animated: false }, me: true, count: 1 }] } as ArchiveMessage;
    expect(reactedWith(message, picked)).toBe(true);
    expect(reactedWith(message, { ...picked, name: '⭐\uFE0F' })).toBe(true);
    expect(reactedWith({ ...message, reactions: [{ ...message.reactions[0]!, emoji: { ...picked, name: '⭐\uFE0F' } }] }, picked)).toBe(true);
    expect(reactedWith({ ...message, reactions: [{ ...message.reactions[0]!, me: false }] }, picked)).toBe(false);
    expect(reactedWith(message, { id: '400000000000000001', name: '⭐', animated: false })).toBe(false);
  });
});
