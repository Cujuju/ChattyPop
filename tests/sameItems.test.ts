// A reloaded list hands back its unchanged items themselves: the emoji picker keys its cells by them, and rebuilt every
// cell each time its catalog was asked for again.
import { describe, expect, it } from 'vitest';
import { keepUnchanged } from '@shared/sameItems';

const emoji = (id: string, name: string) => ({ id, name, animated: false });

describe('keepUnchanged', () => {
  it('keeps the earlier item where the reloaded one says the same', () => {
    const prev = [emoji('1', 'wave'), emoji('2', 'fire')];
    const next = keepUnchanged(prev, [emoji('2', 'fire'), emoji('1', 'wave')]);
    expect(next[0]).toBe(prev[1]);
    expect(next[1]).toBe(prev[0]);
  });

  it('takes the reloaded item where it changed, and where it is new', () => {
    const prev = [emoji('1', 'wave')];
    const renamed = emoji('1', 'hello');
    const added = emoji('3', 'star');
    expect(keepUnchanged(prev, [renamed, added])).toEqual([renamed, added]);
    expect(keepUnchanged(prev, [renamed])[0]).toBe(renamed);
  });

  it('drops what the reload no longer lists, and takes a first load as it is', () => {
    expect(keepUnchanged([emoji('1', 'wave')], [])).toEqual([]);
    const first = [emoji('1', 'wave')];
    expect(keepUnchanged(undefined, first)).toBe(first);
  });
});
