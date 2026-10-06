// Lists DMs first, then servers in Discord folder order or guild_positions. Unlisted archived servers follow by name. Order can arrive before server storage.
import { describe, expect, it } from 'vitest';
import { directory } from '../src/core/queries/directory';
import { putGuildOrder } from '../src/core/queries/guildOrder';
import { guildOrderFromSettings } from '../src/main/discord/guildOrder';
import { seedArchive, tempDb } from './helpers';

const WIRE_BYTES = 2;
const WIRE_FIXED64 = 1;
const FIXED64_BYTES = 8;

const varint = (n: number): number[] => {
  const out: number[] = [];
  for (; n >= 0x80; n = Math.floor(n / 0x80)) out.push((n % 0x80) | 0x80);
  return [...out, n];
};
const tag = (no: number, wire: number): number[] => varint(no * 8 + wire);
const bytesField = (no: number, body: number[]): number[] => [...tag(no, WIRE_BYTES), ...varint(body.length), ...body];
const id64 = (id: string): number[] => {
  const b = Buffer.alloc(FIXED64_BYTES);
  b.writeBigUInt64LE(BigInt(id));
  return [...b];
};
const packed = (no: number, ids: string[]): number[] => bytesField(no, ids.flatMap(id64));
const unpacked = (no: number, ids: string[]): number[] => ids.flatMap((id) => [...tag(no, WIRE_FIXED64), ...id64(id)]);

// Snowflakes above 2^53 require lossless parsing.
const A = '1417911687616401562';
const B = '1536055842414268496';
const C = '9007199254740993123';
const settings = (guildFolders: number[] | null): Buffer =>
  Buffer.from([...bytesField(13, [8, 1]), ...(guildFolders ? bytesField(14, guildFolders) : [])]);

describe('sidebar order from Discord settings', () => {
  it('lists each folder’s servers in turn, ids exact', () => {
    const order = guildOrderFromSettings(settings([...bytesField(1, packed(1, [A, B])), ...bytesField(1, unpacked(1, [C]))]));
    expect(order).toEqual([A, B, C]);
  });

  it('falls back to guild_positions without folders', () => {
    expect(guildOrderFromSettings(settings(packed(2, [C, A])))).toEqual([C, A]);
  });

  it('is unknown when the settings don’t carry it (a partial update)', () => {
    expect(guildOrderFromSettings(settings(null))).toBeNull();
  });
});

describe('directory in sidebar order', () => {
  const guild = (id: string, name: string) => ({ id, name, icon: null });
  const names = (db: ReturnType<typeof tempDb>): string[] => directory(db, 0).map((g) => g.name);

  it('follows the order, unlisted servers after it by name, even when stored after the order', () => {
    const db = tempDb();
    expect(putGuildOrder(db, ['3', '1'])).toBe(true);
    seedArchive(db, [], { guilds: [guild('1', 'Alpha'), guild('2', 'Zulu'), guild('3', 'Mike'), guild('4', 'Bravo')] });
    expect(names(db)).toEqual(['Direct messages', 'Mike', 'Alpha', 'Bravo', 'Zulu']);
    expect(putGuildOrder(db, ['3', '1'])).toBe(false);
    putGuildOrder(db, ['1', '2', '3', '4']);
    expect(names(db)).toEqual(['Direct messages', 'Alpha', 'Zulu', 'Mike', 'Bravo']);
  });
});
