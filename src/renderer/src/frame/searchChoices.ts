// What `from:`, `in:` and `server:` offer while their value is typed: archive people, archived channels and servers.
import { DM_GUILD_ID } from '@shared/discord';
import { archivedChannels, channelSigil, directory } from '@/state/directory';
import { SEARCH_CHOICES_MAX, findSearchPeople } from '@/state/search';
import { serverTerm, type FilterChoice, type NamedChoiceSources } from './searchFilters';

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

/** People matching what is typed, as findPeople ranks them; none before a first letter (all would match). The value is the username. */
async function people(partial: string): Promise<FilterChoice[]> {
  if (!partial.trim()) return [];
  return (await findSearchPeople(partial)).map((p) => ({
    label: p.name,
    // A username names one person; one never seen with a username is named by id, as the person view links them.
    value: p.username ?? `<@${p.id}>`,
    detail: p.username ? `@${p.username}` : undefined,
    lead: { kind: 'person', id: p.id, avatar: p.avatar },
  }));
}

/** Archived server channels (DMs have no name `in:` matches). One whose name another server's channel contains also adds `server:`. */
function channels(partial: string): FilterChoice[] {
  const all = archivedChannels().filter((c) => c.guildId !== DM_GUILD_ID);
  const sharedElsewhere = (c: (typeof all)[number]): boolean => all.some((o) => o.guildId !== c.guildId && lower(o.name).includes(lower(c.name)));
  return best(all, (c) => c.name, partial).map((c) => ({
    label: c.name,
    value: c.name,
    detail: c.guildName,
    lead: { kind: 'channel', sigil: channelSigil(c) },
    narrow: sharedElsewhere(c) ? serverTerm(c.guildName) : undefined,
  }));
}

/** Servers with archived channels. */
function servers(partial: string): FilterChoice[] {
  const archived = directory().filter((g) => g.id !== DM_GUILD_ID && g.channels.some((c) => c.optedIn));
  return best(archived, (g) => g.name, partial).map((g) => ({ label: g.name, value: g.name, lead: { kind: 'server', id: g.id, name: g.name, icon: g.icon } }));
}

export const namedChoiceSources: NamedChoiceSources = { people, channels, servers };
