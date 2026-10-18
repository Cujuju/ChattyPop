import { For, Show } from 'solid-js';
import type { DirectoryChannel, DirectoryGuild } from '@shared/contract';
import { openChannel, shownChannelId } from '@/state/archive';
import { channelLabel, isPrivateThread, threadsOf } from '@/state/directory';
import { mentionedDms, type DmChannel } from '@/state/dms';
import { setSidebarCollapsed } from '@/state/layout';
import { GuildIcon } from '@/ui/GuildIcon';
import { Icon } from '@/ui/icons';
import { DmFace } from '@/ui/DmFace';
import { ThreadsBadge } from '@/ui/ThreadFold';
import { foldGesture, threadsShown, unseenInThreads } from '@/state/threadFolds';
import styles from './Rail.module.css';

const INITIALS_MAX = 2;
/** A channel's tile text: its first letters, ignoring leading symbols and emoji. */
const channelInitials = (name: string): string => (name.match(/[\p{L}\p{N}]/gu) ?? ['#']).slice(0, INITIALS_MAX).join('');

/**
 * One channel or thread tile; threads sit under their channel, marked by data-kind; data-mentioned: unread pings. A
 * channel with threads folds them (state/threadFolds.ts); folded, its corner counts their new messages.
 */
function RailTile(props: { channel: DirectoryChannel; label: string; thread?: boolean; foldable?: boolean }) {
  const id = () => props.channel.id;
  const folded = () => (props.foldable && !threadsShown(id()) ? unseenInThreads(id()) : { newCount: 0, mentionCount: 0 });
  const mentions = () => props.channel.mentionCount + folded().mentionCount;
  const label = () =>
    [props.label, mentions() > 0 ? `${mentions()} mentioning you` : '', folded().newCount > 0 ? `${folded().newCount} new in threads` : ''].filter(Boolean).join(' · ');
  const fold = (e: MouseEvent | KeyboardEvent): boolean => !!props.foldable && foldGesture(e, id());
  return (
    <button
      type="button"
      class={styles.railChannel}
      data-kind={props.thread ? 'thread' : 'channel'}
      data-mentioned={mentions() > 0}
      aria-current={shownChannelId() === id()}
      aria-expanded={props.foldable ? threadsShown(id()) : undefined}
      aria-label={label()}
      title={label()}
      onClick={(e) => { if (!fold(e)) openChannel(props.channel); }}
      onDblClick={fold}
      onKeyDown={fold}
    >
      {channelInitials(props.channel.name)}
      <Show when={folded().newCount > 0}>
        <ThreadsBadge count={folded().newCount} compact class={styles.railThreads} />
      </Show>
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
                  <RailTile channel={c} label={channelLabel(c, g.name)} foldable={threadsOf(c.id).length > 0} />
                  {/* Folded, the open thread stays in sight. */}
                  <For each={threadsOf(c.id).filter((t) => threadsShown(c.id) || t.id === shownChannelId())}>
                    {(t) => <RailTile channel={t} thread label={`${isPrivateThread(t) ? 'Private thread' : 'Thread'} ${t.name} in ${channelLabel(c, g.name)}`} />}
                  </For>
                </>
              )}
            </For>
          </div>
        )}
      </For>
    </nav>
  );
}
