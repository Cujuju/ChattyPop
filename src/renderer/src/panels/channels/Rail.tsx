import { For, Show } from 'solid-js';
import type { DirectoryChannel, DirectoryGuild } from '@shared/contract';
import { openChannel, shownChannelId } from '@/state/archive';
import { channelLabel, isPrivateThread, threadsOf } from '@/state/directory';
import { mentionedDms, type DmChannel } from '@/state/dms';
import { setSidebarCollapsed } from '@/state/layout';
import { GuildIcon } from '@/ui/GuildIcon';
import { Icon } from '@/ui/icons';
import { DmFace } from '@/ui/DmFace';
import styles from './Rail.module.css';

const INITIALS_MAX = 2;
/** A channel's tile text: its first letters, ignoring leading symbols and emoji. */
const channelInitials = (name: string): string => (name.match(/[\p{L}\p{N}]/gu) ?? ['#']).slice(0, INITIALS_MAX).join('');

/** One channel or thread tile; threads sit under their channel, marked by data-kind; data-mentioned: unread pings. */
function RailTile(props: { channel: DirectoryChannel; label: string; thread?: boolean }) {
  const mentions = () => props.channel.mentionCount;
  const label = () => (mentions() > 0 ? `${props.label} · ${mentions()} mentioning you` : props.label);
  return (
    <button
      type="button"
      class={styles.railChannel}
      data-kind={props.thread ? 'thread' : 'channel'}
      data-mentioned={mentions() > 0}
      aria-current={shownChannelId() === props.channel.id}
      aria-label={label()}
      title={label()}
      onClick={() => openChannel(props.channel)}
    >
      {channelInitials(props.channel.name)}
    </button>
  );
}

/** A DM with Discord's count pending: its face with the count, as Discord's server list shows one. */
function RailDm(props: { channel: DmChannel }) {
  const label = () => `${props.channel.name} · ${props.channel.mentionCount} unread`;
  return (
    <button
      type="button"
      class={styles.railDm}
      aria-current={shownChannelId() === props.channel.id}
      aria-label={label()}
      title={label()}
      onClick={() => openChannel(props.channel)}
    >
      <DmFace channel={props.channel} />
      <span class={styles.railDmCount} aria-hidden="true">
        {props.channel.mentionCount}
      </span>
    </button>
  );
}

/**
 * Collapsed sidebar: DMs with unread messages first, then server icons with their watched channels (then each channel's
 * threads) as initial tiles; hover shows the name.
 */
export function Rail(props: { guilds: DirectoryGuild[] }) {
  return (
    <nav class={styles.rail} aria-label="Channels">
      <button type="button" class={styles.collapse} aria-label="Expand sidebar" title="Expand sidebar" onClick={() => setSidebarCollapsed(false)}>
        <Icon name="chevronsRight" />
      </button>
      <Show when={mentionedDms().length > 0}>
        <div class={styles.railDms} aria-label="Unread direct messages" role="group">
          <For each={mentionedDms()}>{(c) => <RailDm channel={c} />}</For>
        </div>
      </Show>
      <For each={props.guilds}>
        {(g) => (
          <div class={styles.railGroup} title={g.name}>
            <span class={styles.railGuild}>
              <GuildIcon id={g.id} name={g.name} icon={g.icon} />
            </span>
            <For each={g.channels}>
              {(c) => (
                <>
                  <RailTile channel={c} label={channelLabel(c, g.name)} />
                  <For each={threadsOf(c.id)}>{(t) => <RailTile channel={t} thread label={`${isPrivateThread(t) ? 'Private thread' : 'Thread'} ${t.name} in ${channelLabel(c, g.name)}`} />}</For>
                </>
              )}
            </For>
          </div>
        )}
      </For>
    </nav>
  );
}
