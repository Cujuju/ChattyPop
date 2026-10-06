import { describe, expect, it, vi } from 'vitest';
import type { ArchiveMessage } from '@shared/contract';

const calls: { kind: 'forward' | 'send'; nonce: string; text?: string }[] = [];
const failNext = { forward: false, send: false };
const answer = (kind: 'forward' | 'send') => async (arg: { nonce: string; text?: string }) => {
  calls.push({ kind, nonce: arg.nonce, ...(arg.text === undefined ? {} : { text: arg.text }) });
  if (failNext[kind]) {
    failNext[kind] = false;
    throw new Error('Discord is down');
  }
};
vi.mock('@/api', () => ({ api: { discord: { forward: answer('forward'), send: answer('send') }, core: { messageById: async () => null } } }));
vi.mock('../src/renderer/src/state/events', () => ({ onAppEvent: () => undefined }));
vi.mock('../src/renderer/src/state/directory', () => ({ channelById: () => ({ guildId: 'g' }), directory: () => [], loadDirectory: async () => undefined }));

// A renderer module: imported by path so the node type-check doesn't follow it.
const statePath = '../src/renderer/src/state/forward';
const { closeForward, forwardMessage, startForward } = (await import(statePath)) as {
  closeForward(): void;
  forwardMessage(m: ArchiveMessage, channelId: string, note: string): Promise<void>;
  startForward(m: ArchiveMessage): void;
};
const message = { id: 'm1', channelId: 'c1', deletedAt: null } as ArchiveMessage;

describe('forward retries', () => {
  it('re-sends only what failed, with the first try’s nonces; a closed and reopened window starts over', async () => {
    startForward(message);
    failNext.forward = true;
    await expect(forwardMessage(message, 'c2', 'look')).rejects.toThrow();
    failNext.send = true;
    await expect(forwardMessage(message, 'c2', 'look')).rejects.toThrow();
    // Forward pressed again on the same message while its window is open: the pending retry keeps its history.
    startForward(message);
    await forwardMessage(message, 'c2', 'look');
    const [f1, f2, n1, n2] = calls;
    expect(calls.map((c) => c.kind)).toEqual(['forward', 'forward', 'send', 'send']);
    // The forward that failed goes again as the same message; once posted it never goes again.
    expect(f2!.nonce).toBe(f1!.nonce);
    expect(n2).toEqual(n1);
    expect(n1!.text).toBe('look');

    calls.length = 0;
    closeForward();
    startForward(message);
    // Invalid notes prevent forwarding.
    await expect(forwardMessage(message, 'c2', 'x'.repeat(2001))).rejects.toThrow(/2000 characters/);
    expect(calls).toEqual([]);
    await forwardMessage(message, 'c2', '');
    expect(calls.map((c) => c.kind)).toEqual(['forward']);
    expect(calls[0]!.nonce).not.toBe(f1!.nonce);
  });
});
