import { expect, it } from 'vitest';
import { referenceWork } from '../src/core/rollups/referenceWork';
import type { ArchiveRead } from '../src/core/plugins/pluginDb';

it('matches literal substring classification for overlaps, suffixes, numeric ids and Unicode', async () => {
  const ids = ['abc', 'bc', 'bcd', '1234567890', '😀place', 'é', '界'];
  const alphabet = ['a', 'b', 'c', 'd', '😀', 'é', '界', '1234567890'];
  const samples = 512; // Exercise suffix fallback and overlapping matches in a deterministic corpus.
  const texts = Array.from({ length: samples }, (_, n) => {
    let text = '';
    do { text += alphabet[n % alphabet.length]; n = Math.floor(n / alphabet.length); } while (n);
    return text;
  }).concat(['', 'ordinary', '😀place', 'é', 'prefix1234567890suffix', 'abbcd']);
  for (const catalog of [ids, [], ['']]) {
    const read = (async (sql: string) => sql.startsWith('SELECT id FROM channels') ? catalog.map((id) => ({ id }))
      : texts.map((text, n) => ({ kind: 'message', id: String(n), channel_id: 'c', day: '2026-01-01', text, indexed: n % 2 }))) as ArchiveRead;
    const rows = await referenceWork(null, read, new AbortController().signal, { sql: 'SELECT candidates', bootstrap: 1 });
    expect(rows.map(({ id, referenced }) => ({ id, referenced }))).toEqual(texts.flatMap((text, n) => {
      const referenced = Number(catalog.some((id) => text.includes(id)));
      return referenced === n % 2 ? [] : [{ id: String(n), referenced }];
    }));
  }
});
