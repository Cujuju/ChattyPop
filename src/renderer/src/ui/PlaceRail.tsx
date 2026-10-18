// Discord's two left columns as a place picker: servers, then the picked server's channels and their threads.
import { For, Show, type JSX } from 'solid-js';
import type { DirectoryChannel, DirectoryGuild } from '@shared/contract';
import { DM_GUILD_ID } from '@shared/discord';
import { channelById, channelSigil, directory, isThread } from '@/state/directory';
import { isDmChannel } from '@/state/dmRules';
import { foldGesture, threadsShown, unseenInThreads } from '@/state/threadFolds';
import { look } from '@/theme/look';
import { DmFace } from './DmFace';
import { GuildIcon } from './GuildIcon';
import { Icon } from './icons';
import { FoldChevron, ThreadSpine, ThreadsBadge } from './ThreadFold';
import styles from './PlaceRail.module.css';

/** A picked place: a server (every channel in it) or one channel or thread. */
export interface RailPlace { by: 'guild' | 'channel'; id: string }

/** What each place holds, shown beside it. */
export interface PlaceCounts {
  guild(id: string): number;
  /** A channel's or thread's own. */
  channel(id: string): number;
  /** All servers' together. */
  total(): number;
  /** A count as a server mark's tooltip words it, e.g. "3 files". */
  label(count: number): string;
}

export interface PlaceRailProps {
  /** Null: no place, or All servers when that mark shows. */
  place: RailPlace | null;
  onPlace(place: RailPlace | null): void;
  /** The picked server's channel column is folded away; the place stays picked. */
  channelsHidden: boolean;
  onChannelsHidden(hidden: boolean): void;
  /** Which servers, channels and threads list; the picked place always does. */
  listsGuild(guild: DirectoryGuild): boolean;
  listsChannel(channel: DirectoryChannel): boolean;
  /** Absent: places show no counts. */
  counts?: PlaceCounts;
  /** Leads the servers with an All servers mark, which picks null. */
  allServers?: boolean;
  /** Places can't be picked; the channel column still folds. */
  disabled?: boolean;
}

/** `expanded`: whether its channel column shows (absent for All servers, which has none). */
function ServerButton(props: { label: string; current: boolean; expanded?: boolean; disabled?: boolean; onClick: () => void; children: JSX.Element }) {
  return (
    <button type="button" class={`${styles.server} ${look.navItem}`} aria-current={props.current ? 'page' : undefined} aria-expanded={props.expanded}
      disabled={props.disabled}
      aria-label={props.label} title={props.label} onClick={() => props.onClick()}>{props.children}</button>
  );
}

/**
 * A place to pick. `lead`: before the name (a fold slot, a thread's spine, a DM's face); `trail`: before the count.
 * `fold`: a channel's fold gestures (foldGesture), tried before a click picks it.
 */
function PlaceButton(props: { label: string; count?: number; current: boolean; onClick: () => void; thread?: boolean; expanded?: boolean; disabled?: boolean;
  fold?: (e: MouseEvent | KeyboardEvent) => boolean; lead?: JSX.Element; trail?: JSX.Element }) {
  const fold = (e: MouseEvent | KeyboardEvent): boolean => props.fold?.(e) ?? false;
  return (
    <button type="button" class={`${styles.place} ${look.navItem}`} data-thread={props.thread ? '' : undefined} disabled={props.disabled}
      aria-current={props.current ? 'page' : undefined} aria-expanded={props.expanded}
      onClick={(e) => { if (!fold(e)) props.onClick(); }} onDblClick={fold} onKeyDown={fold}>
      {props.lead}
      <span class={`${styles.placeName} ${look.text}`} data-size={props.thread ? 'xs' : 'sm'} data-tone={props.thread ? 'secondary' : undefined}>{props.label}</span>
      {props.trail}
      <Show when={props.count !== undefined}>
        <span class={look.text} data-size="2xs" data-tone="muted" data-figures="tabular">{props.count}</span>
      </Show>
    </button>
  );
}

export function PlaceRail(props: PlaceRailProps) {
  /** The server the place is in: the picked one, or the picked channel's. */
  const placeGuild = (): string | null => {
    const p = props.place;
    if (!p) return null;
    return p.by === 'guild' ? p.id : channelById(p.id)?.guildId ?? null;
  };
  const pickedChannel = (): string | null => (props.place?.by === 'channel' ? props.place.id : null);
  const listed = (c: DirectoryChannel): boolean => props.listsChannel(c) || c.id === pickedChannel();
  const servers = () => directory().filter((g) => props.listsGuild(g) || g.id === placeGuild());
  const guild = () => directory().find((g) => g.id === placeGuild());
  /** The picked server's channel column, unless folded away. */
  const column = () => (props.channelsHidden ? undefined : guild());
  const channels = () => guild()?.channels.filter((c) => !isThread(c) && listed(c)) ?? [];
  /** A channel's listed threads, most recently active first, as the Archive lists them. */
  const threadsOf = (channelId: string): DirectoryChannel[] => (guild()?.channels ?? [])
    .filter((t) => isThread(t) && t.parentId === channelId && listed(t))
    .sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0));
  /** DMs have no threads: their list keeps no fold slot. */
  const slot = (): boolean => placeGuild() !== DM_GUILD_ID;
  const serverLabel = (name: string, count: () => number): string => (props.counts ? `${name} · ${props.counts.label(count())}` : name);
  /** Picks a server (or DMs) and shows its channels; the picked one again folds or unfolds them, keeping the place. */
  const pickServer = (guildId: string): void => {
    if (placeGuild() === guildId) { props.onChannelsHidden(!props.channelsHidden); return; }
    props.onPlace({ by: 'guild', id: guildId });
    props.onChannelsHidden(false);
  };

  /** A channel, then its listed threads; folded (shared with the Archive), only a picked thread shows. */
  function ChannelPlace(p: { channel: DirectoryChannel }) {
    const c = () => p.channel;
    const dm = () => { const channel = c(); return isDmChannel(channel) ? channel : null; };
    const threads = () => threadsOf(c().id);
    const foldable = (): boolean => threads().length > 0;
    const shown = (): boolean => threadsShown(c().id);
    const unseen = (): number => (foldable() && !shown() ? unseenInThreads(c().id).newCount : 0);
    return (
      <>
        <PlaceButton label={dm() ? c().name : `${channelSigil(c())}${c().name}`} count={props.counts?.channel(c().id)} disabled={props.disabled}
          current={pickedChannel() === c().id} onClick={() => props.onPlace({ by: 'channel', id: c().id })}
          expanded={foldable() ? shown() : undefined} fold={(e) => foldable() && foldGesture(e, c().id)}
          lead={<>
            <Show when={slot()}><FoldChevron foldable={foldable()} open={shown()} /></Show>
            {/* A DM reads as the DM list shows it: its face and name, no sigil. */}
            <Show when={dm()}>{(face) => <DmFace channel={face()} />}</Show>
          </>}
          trail={<Show when={unseen() > 0}><ThreadsBadge count={unseen()} /></Show>} />
        <For each={threads().filter((t) => shown() || t.id === pickedChannel())}>{(t) => (
          <PlaceButton label={t.name} count={props.counts?.channel(t.id)} thread disabled={props.disabled} lead={<ThreadSpine />}
            current={pickedChannel() === t.id} onClick={() => props.onPlace({ by: 'channel', id: t.id })} />
        )}</For>
      </>
    );
  }

  return (
    <>
      {/* The last column before the pane carries its rule: the channels when a server is picked, else the servers. */}
      <nav class={`${styles.servers} ${look.chrome} ${column() ? '' : look.ruleEnd}`} aria-label="Servers">
        <Show when={props.allServers}>
          <ServerButton label={serverLabel('All servers', () => props.counts?.total() ?? 0)} current={!props.place} disabled={props.disabled} onClick={() => props.onPlace(null)}>
            <Icon name="archive" class={styles.glyph} />
          </ServerButton>
        </Show>
        <For each={servers()}>{(g) => (
          <ServerButton label={serverLabel(g.name, () => props.counts?.guild(g.id) ?? 0)} current={placeGuild() === g.id} disabled={props.disabled}
            expanded={placeGuild() === g.id ? !props.channelsHidden : undefined} onClick={() => pickServer(g.id)}>
            <Show when={g.id !== DM_GUILD_ID} fallback={<Icon name="conversation" class={styles.glyph} />}><GuildIcon id={g.id} name={g.name} icon={g.icon} /></Show>
          </ServerButton>
        )}</For>
      </nav>
      <Show when={column()}>{(g) => (
        <nav class={`${styles.channels} ${look.ruleEnd}`} aria-label={`Channels in ${g().name}`}>
          <div class={styles.headingRow}>
            <h3 class={`${styles.heading} ${look.text}`} data-size="xs" data-weight="semibold" data-tone="secondary">{g().name}</h3>
            <button type="button" class={`${styles.fold} ${look.iconButton}`} aria-label="Hide channels" title="Hide channels (click the server again to show them)"
              onClick={() => props.onChannelsHidden(true)}><Icon name="chevronsLeft" /></button>
          </div>
          <PlaceButton label={g().id === DM_GUILD_ID ? 'All conversations' : 'All channels'} count={props.counts?.guild(g().id)} current={props.place?.by === 'guild'} disabled={props.disabled}
            onClick={() => props.onPlace({ by: 'guild', id: g().id })} lead={<Show when={slot()}><FoldChevron foldable={false} open={false} /></Show>} />
          <For each={channels()}>{(c) => <ChannelPlace channel={c} />}</For>
        </nav>
      )}</Show>
    </>
  );
}
