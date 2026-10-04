// Servers and channels as removable chips with a picker that adds more: a rule's "Where" and the muted places.
import { archivedChannels, channelById, channelSigil, directory } from '@/state/directory';
import { AddPicker, ChipRow, type PickOption } from './rules/pickers';

/** Chosen servers and channels, by id. */
export interface Places {
  guildIds: string[];
  channelIds: string[];
}

/** Picker values: a server or a channel id, told apart by prefix. */
const GUILD = 'g:';
const CHANNEL = 'c:';

/** The chosen places as chips, and a picker offering the archived servers and channels not chosen yet. */
export function PlacePicker(props: { places: Places; onChange: (places: Places) => void; guildHint: string }) {
  const values = (): string[] => [...props.places.guildIds.map((id) => GUILD + id), ...props.places.channelIds.map((id) => CHANNEL + id)];
  const options = (): PickOption[] => {
    const chosen = new Set(values());
    const channels = archivedChannels();
    const archived = new Set(channels.map((ch) => ch.id));
    const guilds = directory().filter((g) => g.channels.some((ch) => archived.has(ch.id)));
    return [
      ...guilds.map((g) => ({ value: GUILD + g.id, label: g.name, hint: props.guildHint })),
      ...channels.map((ch) => ({ value: CHANNEL + ch.id, label: `${channelSigil(ch)}${ch.name}`, hint: ch.guildName })),
    ].filter((o) => !chosen.has(o.value));
  };
  const add = (v: string): void => {
    const p = props.places;
    props.onChange(v.startsWith(GUILD) ? { ...p, guildIds: [...p.guildIds, v.slice(GUILD.length)] } : { ...p, channelIds: [...p.channelIds, v.slice(CHANNEL.length)] });
  };
  const remove = (v: string): void => {
    const p = props.places;
    props.onChange({ guildIds: p.guildIds.filter((id) => GUILD + id !== v), channelIds: p.channelIds.filter((id) => CHANNEL + id !== v) });
  };
  const name = (v: string): string => {
    if (v.startsWith(GUILD)) return directory().find((g) => g.id === v.slice(GUILD.length))?.name ?? 'A server';
    const ch = channelById(v.slice(CHANNEL.length));
    return ch ? `${channelSigil(ch)}${ch.name}` : 'A channel';
  };
  return (
    <ChipRow items={values()} label={name} onRemove={remove}>
      <AddPicker label="Server or channel" options={options} placeholder="Server or channel name" onPick={add} />
    </ChipRow>
  );
}
