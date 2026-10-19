// The place rail as one searchable picker, where a rail has no room (the phone, a form): each server heading its channels, direct messages last.
import type { DirectoryChannel, DirectoryGuild } from '@shared/contract';
import { DM_GROUP_NAME, DM_GUILD_ID } from '@shared/discord';
import { channelSigil, directory, isThread } from '@/state/directory';
import { isDmChannel } from '@/state/dmRules';
import { DmFace } from './DmFace';
import { GuildIcon } from './GuildIcon';
import { Icon } from './icons';
import type { RailPlace } from './PlaceRail';
import { SearchSelect, type SearchOption } from './SearchSelect';

export interface PlaceSelectProps {
  place: RailPlace | null;
  onPlace(place: RailPlace | null): void;
  /** Which servers and channels list; the picked place always does. */
  listsGuild(guild: DirectoryGuild): boolean;
  listsChannel(channel: DirectoryChannel): boolean;
  /** Names the picker, e.g. "Channel". */
  label: string;
  /** Leads with a choice of everywhere, named this (e.g. "All channels"), which picks null; absent: none. */
  everywhere?: string;
  id?: string;
  class?: string;
  disabled?: boolean;
}

const EVERYWHERE = '';
const valueOf = (p: RailPlace | null): string => (p ? `${p.by}:${p.id}` : EVERYWHERE);
function placeOf(v: string): RailPlace | null {
  const at = v.indexOf(':');
  const by = v.slice(0, at);
  return at > 0 && (by === 'guild' || by === 'channel') ? { by, id: v.slice(at + 1) } : null;
}

export function PlaceSelect(props: PlaceSelectProps) {
  const picked = (id: string): boolean => props.place?.id === id;
  /** A server, then its listed channels under it; DMs are found by filtering, so the list stays a list of places. */
  const serverOptions = (g: DirectoryGuild): SearchOption[] => {
    const channels = g.channels.filter((c) => !isThread(c) && (props.listsChannel(c) || picked(c.id)));
    if (!props.listsGuild(g) && !picked(g.id) && !channels.some((c) => picked(c.id))) return [];
    const dms = g.id === DM_GUILD_ID;
    return [
      { value: valueOf({ by: 'guild', id: g.id }), label: dms ? DM_GROUP_NAME : g.name,
        lead: () => (dms ? <Icon name="conversation" /> : <GuildIcon id={g.id} name={g.name} icon={g.icon} />) },
      ...channels.map((c): SearchOption => ({
        value: valueOf({ by: 'channel', id: c.id }), label: c.name, nested: true, searchOnly: dms && !picked(c.id),
        lead: () => (isDmChannel(c) ? <DmFace channel={c} small /> : channelSigil(c)),
      })),
    ];
  };
  const options = (): SearchOption[] => [
    ...(props.everywhere !== undefined ? [{ value: EVERYWHERE, label: props.everywhere, lead: () => <Icon name="archive" /> }] : []),
    ...[...directory()].sort((a, b) => Number(a.id === DM_GUILD_ID) - Number(b.id === DM_GUILD_ID)).flatMap(serverOptions),
  ];
  return (
    <SearchSelect id={props.id} class={props.class} label={props.label} searchLabel="Find a server or channel" disabled={props.disabled}
      value={valueOf(props.place)} options={options()} onChange={(v) => props.onPlace(placeOf(v))} />
  );
}
