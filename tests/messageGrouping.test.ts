import { describe, expect, it } from 'vitest';
import type { ArchiveMessage } from '@shared/contract';
import { MS_PER_MIN } from '@shared/units';
import { canGroupMessage, GROUP_GAP_MS } from '../src/renderer/src/ui/messageGrouping';

const T0 = new Date(2026, 8, 1, 12).getTime();
const message = (ts = T0, authorId = 'alice', replyToId: string | null = null) => ({
  ts, author: { id: authorId } as ArchiveMessage['author'], replyToId,
});

describe('shared Archive and Conversation grouping', () => {
  it('groups consecutive messages from the same author strictly within the gap', () => {
    expect(canGroupMessage(message(), message(T0 + GROUP_GAP_MS - 1))).toBe(true);
    expect(canGroupMessage(message(), message(T0 + GROUP_GAP_MS))).toBe(false);
  });

  it('starts a header for the first message, a different author or a reply', () => {
    expect(canGroupMessage(undefined, message())).toBe(false);
    expect(canGroupMessage(message(), message(T0, 'bob'))).toBe(false);
    expect(canGroupMessage(message(), message(T0, 'alice', 'reply'))).toBe(false);
  });

  it('starts a header across a local day boundary even inside the gap', () => {
    const midnight = new Date(2026, 8, 2).getTime();
    expect(canGroupMessage(message(midnight - MS_PER_MIN), message(midnight))).toBe(false);
  });
});
