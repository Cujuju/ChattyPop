import { describe, expect, it } from 'vitest';
import { findPeople, peopleByIds } from '../src/core/queries/people';
import { ARRIVAL } from '../src/core/arrival';
import { rawMessage, seedArchive, tempDb } from './helpers';

describe('people by name', () => {
  it('finds by display name, username or nickname, treating LIKE wildcards literally', () => {
    const db = tempDb();
    const archive = seedArchive(db, [{ id: 'c1' }]);
    archive.ingestMessages(
      [
        rawMessage('c1', 1, 'a', { author: { id: '1', username: 'tony_t', global_name: 'Tony' } }),
        rawMessage('c1', 2, 'b', { author: { id: '2', username: 'stat', global_name: null }, member: { nick: 'Statler' } } as never),
        rawMessage('c1', 3, 'c', { author: { id: '3', username: 'tonyxt', global_name: 'Other' } }),
      ],
      ARRIVAL.gateway,
    );
    expect(findPeople(db, 'ton', 10).map((p) => p.name)).toEqual(['Other', 'Tony']);
    expect(findPeople(db, 'y_t', 10).map((p) => p.id)).toEqual(['1']);
    expect(findPeople(db, 'statl', 10).map((p) => p.name)).toEqual(['stat']);
    expect(findPeople(db, '  ', 10)).toEqual([]);
    expect(peopleByIds(db, ['2', 'nobody']).map((p) => p.name)).toEqual(['stat']);
  });
});
