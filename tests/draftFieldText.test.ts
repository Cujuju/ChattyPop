import { describe, expect, it } from 'vitest';
import { expandEmojiTokens } from '@shared/compose';
import type { CustomEmoji } from '@shared/emoji';
import { draftFieldBoundary, draftFieldParts } from '../src/renderer/src/ui/draftFieldText';
import { DraftFieldHistory } from '../src/renderer/src/ui/draftFieldHistory';

const pog: CustomEmoji = { id: '100000000000000001', name: 'pog', animated: false };
const animated: CustomEmoji = { id: '200000000000000002', name: 'pog', animated: true };
const picked = new Map([['pog', pog], ['pog~1', animated]]);

describe('inline picked emoji in a draft', () => {
  it('renders selected identities, including duplicate names, and leaves unselected shortcuts as text', () => {
    expect(draftFieldParts('Hi :pog: :pog~1: :unknown: 😀', picked)).toEqual([
      { text: 'Hi ' }, { text: ':pog:', emoji: pog }, { text: ' ' }, { text: ':pog~1:', emoji: animated }, { text: ' :unknown: 😀' },
    ]);
  });

  it('renders copied Discord markup without needing a picker selection', () => {
    expect(draftFieldParts(`<:${pog.name}:${pog.id}> <a:${animated.name}:${animated.id}>`, new Map())).toEqual([
      { text: `<:pog:${pog.id}>`, emoji: pog }, { text: ' ' }, { text: `<a:pog:${animated.id}>`, emoji: animated },
    ]);
  });

  it('keeps cursor and selection boundaries outside an emoji token', () => {
    const parts = draftFieldParts('a:pog:b', picked);
    expect(draftFieldBoundary(parts, 3)).toBe(1);
    expect(draftFieldBoundary(parts, 3, true)).toBe(6);
    expect(draftFieldBoundary(parts, 6)).toBe(6);
    expect(draftFieldBoundary(parts, 99)).toBe(7);
  });

  it('sends copied markup intact even when a same-named emoji is picked in the destination draft', () => {
    const copied = `<a:pog:${animated.id}>`;
    expect(expandEmojiTokens(`${copied} :pog:`, picked)).toBe(`${copied} <:pog:${pog.id}>`);
  });

  it('preserves literal angle brackets and incomplete markup as editable message text', () => {
    expect(draftFieldParts('<img src=x onerror=alert(1)> <:pog:bad> :unknown:', picked)).toEqual([
      { text: '<img src=x onerror=alert(1)> <:pog:bad> :unknown:' },
    ]);
  });
});

describe('draft editor undo', () => {
  it('undoes consecutive typing together, then an emoji selection separately with its caret', () => {
    const h = new DraftFieldHistory();
    h.record(':po', { start: 0, end: 0 }, { start: 3, end: 3 }, true, 1);
    h.record(':pog', { start: 3, end: 3 }, { start: 4, end: 4 }, true, 2);
    h.record(':pog: ', { start: 0, end: 4 }, { start: 6, end: 6 });
    expect(h.undo()).toEqual({ text: ':pog', start: 0, end: 4 });
    expect(h.undo()?.text).toBe('');
    expect(h.redo()?.text).toBe(':pog');
    expect(h.redo()?.text).toBe(':pog: ');
  });

  it('drops redo after a fresh edit and separates typing after a caret move', () => {
    const h = new DraftFieldHistory('abc');
    h.record('abcd', { start: 3, end: 3 }, { start: 4, end: 4 }, true, 1);
    h.record('xabcd', { start: 0, end: 0 }, { start: 1, end: 1 }, true, 2);
    expect(h.undo()?.text).toBe('abcd');
    h.record('abcde', { start: 4, end: 4 }, { start: 5, end: 5 }, true, 3);
    expect(h.redo()).toBeNull();
  });
});
