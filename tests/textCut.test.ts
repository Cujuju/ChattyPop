// Text cut for Jev and other length caps never splits an emoji: half of one is invalid Unicode, which Jev rejects.
import { describe, expect, it } from 'vitest';
import { cutText } from '@shared/text';
import { MAX_MESSAGE_CHARS, clipMessage } from '../src/core/ai/clip';

describe('text cut for Jev', () => {
  it('never ends on half an emoji', () => {
    const s = `${'a'.repeat(MAX_MESSAGE_CHARS - 1)}😀 tail`;
    const clipped = clipMessage(s);
    expect(clipped.isWellFormed()).toBe(true);
    expect(clipped).toBe(`${'a'.repeat(MAX_MESSAGE_CHARS - 1)}…`);
    expect(cutText('ab😀', 3)).toBe('ab');
    expect(cutText('ab😀', 4)).toBe('ab😀');
  });
});
