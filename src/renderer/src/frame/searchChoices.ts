// What `from:`, `in:` and `server:` offer while their value is typed: archive people, archived channels and servers.
import { DM_GUILD_ID } from '@shared/discord';
import { mentionedUserId } from '@shared/searchQuery';
import { archivedChannels, channelSigil, directory } from '@/state/directory';
import { SEARCH_CHOICES_MAX, findSearchPeople, searchPersonById } from '@/state/search';
import { serverTerm, type FilterChoice, type NamedChoiceSources, type QueryChip, type SearchFilter } from './searchFilters';

const lower = (s: string): string => s.toLowerCase();

/** Items whose name contains `partial`, those starting with it first, else in their given order (sort is stable); at most SEARCH_CHOICES_MAX. */
const best = <T>(items: readonly T[], name: (t: T) => string, partial: string): T[] => {
  const p = lower(partial);
  const later = (t: T): number => Number(!lower(name(t)).startsWith(p));
  return items
    .filter((t) => lower(name(t)).includes(p))
    .sort((a, b) => later(a) - later(b))
    .slice(0, SEARCH_CHOICES_MAX);
};

/** People matching what is typed, as findPeople ranks them, or the one a `<@id>` names; none before a first letter (all would match). The value is the username. */
async function people(partial: string): Promise<FilterChoice[]> {
  if (!partial.trim()) return [];
  const id = mentionedUserId(partial.trim());
  return (await (id ? searchPersonById(id) : findSearchPeople(partial))).map((p) => ({
    label: p.name,
    // A username names one person; one never seen with a username is named by id, as the person view links them.
    value: p.username ?? `<@${p.id}>`,
    detail: p.username ? `@${p.username}` : undefined,
    lead: { kind: 'person', id: p.id, avatar: p.avatar },
  }));
}

/** Archived server channels (DMs have no name `in:` matches), with their server's icon. One whose name another server's channel contains also adds `server:`. */
function channels(partial: string): FilterChoice[] {
  const all = archivedChannels().filter((c) => c.guildId !== DM_GUILD_ID);
  const icons = new Map(directory().map((g) => [g.id, g.icon]));
  const sharedElsewhere = (c: (typeof all)[number]): boolean => all.some((o) => o.guildId !== c.guildId && lower(o.name).includes(lower(c.name)));
  return best(all, (c) => c.name, partial).map((c) => ({
    label: c.name,
    value: c.name,
    detail: c.guildName,
    lead: { kind: 'server', id: c.guildId, name: c.guildName, icon: icons.get(c.guildId) ?? null },
    sigil: channelSigil(c),
    narrow: sharedElsewhere(c) ? serverTerm(c.guildName) : undefined,
  }));
}

/** Servers with archived channels. */
function servers(partial: string): FilterChoice[] {
  const archived = directory().filter((g) => g.id !== DM_GUILD_ID && g.channels.some((c) => c.optedIn));
  return best(archived, (g) => g.name, partial).map((g) => ({ label: g.name, value: g.name, lead: { kind: 'server', id: g.id, name: g.name, icon: g.icon } }));
}

export const namedChoiceSources: NamedChoiceSources = { people, channels, servers };

/** People a chip named, picked or looked up: their lookup is a core call, so a chip shows the answer once it has one. */
const knownPeople = new Map<string, FilterChoice | null>();
const knownKey = (key: string, value: string): string => `${key}:${lower(value)}`;

/** Keeps a picked person, so its chip names them at once. */
export const rememberChoice = (key: string, choice: FilterChoice): void => void (choice.lead?.kind === 'person' && knownPeople.set(knownKey(key, choice.value), choice));

/**
 * The person, place or value `chip` names, for its label: the choice its filter offers for exactly its value. A channel
 * prefers the server a `server:` chip names. Null when none is exact (free text, an unknown name).
 */
export function chipChoice(chip: QueryChip, filter: SearchFilter | undefined, chips: readonly QueryChip[]): FilterChoice | null | Promise<FilterChoice | null> {
  if (!filter || chip.problem) return null;
  const known = knownPeople.get(knownKey(chip.key, chip.value));
  if (known !== undefined) return known;
  const server = chips.find((c) => c.key === 'server' && !c.negated)?.value;
  const exact = (list: readonly FilterChoice[]): FilterChoice | null => {
    if (mentionedUserId(chip.value)) return list[0] ?? null;
    const named = list.filter((c) => lower(c.value) === lower(chip.value));
    return named.find((c) => server !== undefined && lower(c.detail ?? '') === lower(server)) ?? named[0] ?? null;
  };
  const list = filter.choices(chip.value);
  if (!(list instanceof Promise)) return exact(list);
  return list.then(
    (l) => {
      const choice = exact(l);
      knownPeople.set(knownKey(chip.key, chip.value), choice);
      return choice;
    },
    () => null,
  );
}
