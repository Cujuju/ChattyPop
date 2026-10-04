import { For, Show } from 'solid-js';
import { SegButton, SegGroup } from '@cujuju/solidjs-seg-buttons';
import type { DirectoryChannel, DirectoryGuild } from '@shared/contract';
import { DM_GUILD_ID, TEXT_CHANNEL_TYPES } from '@shared/discord';
import { channelSigil, directory, isPrivateThread, isThread, PRIVATE_THREAD_HINT, syncProgress, threadsOf } from '@/state/directory';
import { openChannel, shownChannelId } from '@/state/archive';
import { openDms, unreadDms } from '@/state/dms';
import { browsingServers as browsing, setBrowsingServers as setBrowsing, setSidebarCollapsed, setSidebarMode, sidebarCollapsed, sidebarMode, type SidebarMode } from '@/state/layout';
import { channelMenu } from '@/state/channelPolicy';
import { guildPrivacyMenu } from '@/state/privacy';
import { aiSettings } from '@/state/preferences';
import { inCompanion, openContextMenu } from '@/state/ui';
import { EyeIcon } from '@/ui/EyeIcon';
import { GuildIcon } from '@/ui/GuildIcon';
import { PanelHeader, headerStyles as hs } from '@/ui/PanelHeader';
import { Browse } from './Browse';
import { Dms } from './Dms';
import { Icon } from '@/ui/icons';
import styles from './Channels.module.css';
import { Rail } from './Rail';

/**
 * Servers mode: opted-in channels grouped by server; "browse" lists every server to opt channels in or out. DMs mode:
 * the account's direct messages (Dms.tsx). On the phone (its drawer) both are read-only: choosing channels and
 * collapsing the sidebar stay on the desktop.
 */
export function ChannelsPanel() {
  const servers = (): boolean => sidebarMode() === 'servers';
  /** Browse belongs to Servers mode; DMs mode keeps it for when Servers returns. */
  const browsingServers = (): boolean => servers() && browsing();
  const guilds = (): DirectoryGuild[] => directory().filter((g) => g.id !== DM_GUILD_ID);
  const textChannels = (g: DirectoryGuild): DirectoryChannel[] => g.channels.filter((c) => TEXT_CHANNEL_TYPES.has(c.kind) && !isThread(c));
  const archivedCount = (): number => guilds().reduce((n, g) => n + textChannels(g).filter((c) => c.optedIn).length, 0);
  const knownCount = (): number => guilds().reduce((n, g) => n + textChannels(g).length, 0);
  const archivedDms = (): number => openDms().filter((c) => c.dm.archived === 'on').length;
  const watched = (): DirectoryGuild[] =>
    guilds()
      .map((g) => ({ ...g, channels: g.channels.filter((c) => c.optedIn && !isThread(c)) }))
      .filter((g) => g.channels.length > 0);

  return (
    <Show when={inCompanion || !sidebarCollapsed()} fallback={<Rail guilds={watched()} />}>
      <section class="cp-panel" aria-label="Channels">
        <PanelHeader
          section="channels"
          title={browsingServers() ? 'All servers' : 'Archive'}
          meta={
            browsingServers() ? undefined : servers() ? (
              <span title={`${archivedCount()} of ${knownCount()} known text channels archived`}>
                {archivedCount()}/{knownCount()}
              </span>
            ) : (
              <span title={`${archivedDms()} of ${openDms().length} open conversations archived`}>{openDms().length} DMs</span>
            )
          }
        >
          <Show when={!inCompanion}>
            <div class={hs.actions}>
              <Show when={servers()}>
                <button
                  type="button"
                  class={hs.iconAction}
                  aria-pressed={browsing()}
                  aria-label={browsing() ? 'Done choosing channels' : 'Choose channels to archive'}
                  title={browsing() ? 'Done' : 'Choose channels to archive'}
                  onClick={() => setBrowsing(!browsing())}
                >
                  <Icon name={browsing() ? 'check' : 'plus'} />
                </button>
              </Show>
              <button type="button" class={hs.iconAction} aria-label="Collapse sidebar to icons" title="Collapse sidebar" onClick={() => setSidebarCollapsed(true)}>
                <Icon name="chevronsLeft" />
              </button>
            </div>
          </Show>
        </PanelHeader>
        <ModeSwitch />
        <Show when={servers()} fallback={<Dms />}>
          <div class={styles.body}>
            <Show when={browsing()} fallback={<Watched guilds={watched()} onBrowse={() => setBrowsing(true)} totalText={(id) => textChannels(guilds().find((g) => g.id === id)!).length} />}>
              <Browse />
            </Show>
          </div>
        </Show>
      </section>
    </Show>
  );
}

/** Servers | DMs, full width under the header; the DMs segment carries the unread-DM count. */
function ModeSwitch() {
  return (
    <div class={styles.modeBand}>
      <SegGroup role="radiogroup" ariaLabel="Sidebar lists" class={styles.modeGroup} value={sidebarMode()} onChange={(v: SidebarMode) => setSidebarMode(v)}>
        <SegButton value="servers" label="Servers" size="sm" class={styles.modeSegment} />
        <SegButton value="dms" label="DMs" size="sm" class={styles.modeSegment} ariaLabel={unreadDms() ? `DMs, ${unreadDms()} unread` : 'DMs'}>
          <span class={styles.modeLabel}>
            DMs
            <Show when={unreadDms() > 0}>
              <span class={styles.modeCount}>{unreadDms()}</span>
            </Show>
          </span>
        </SegButton>
      </SegGroup>
    </div>
  );
}

function Watched(props: { guilds: DirectoryGuild[]; onBrowse: () => void; totalText: (guildId: string) => number }) {
  return (
    <Show
      when={props.guilds.length > 0}
      fallback={
        <div class={styles.empty}>
          <p class={styles.emptyText}>{inCompanion ? 'No channels archived yet. Choose them on your PC.' : 'No channels archived yet.'}</p>
          <Show when={!inCompanion}>
            <button type="button" class={styles.emptyAction} onClick={() => props.onBrowse()}>
              Choose channels
            </button>
          </Show>
        </div>
      }
    >
      <For each={props.guilds}>
        {(g) => (
          <div class={styles.group}>
            <div class="cp-sidebar-heading" onContextMenu={(e) => openContextMenu(e, guildPrivacyMenu(g))}>
              <GuildIcon id={g.id} name={g.name} icon={g.icon} />
              <span class={styles.guildName}>{g.name}</span>
              <Show when={g.hideInPrivacy}>
                <span class={styles.privateMark} title="Private: hidden, with all its channels, while privacy mode is on">
                  <EyeIcon class={styles.privateIcon} />
                </span>
              </Show>
              <span class={styles.count} title="Archived / text channels in this server">
                {g.channels.length}/{props.totalText(g.id)}
              </span>
            </div>
            <For each={g.channels}>
              {(c) => (
                <>
                  <ChannelRow channel={c} />
                  <For each={threadsOf(c.id)}>{(t) => <ChannelRow channel={t} />}</For>
                </>
              )}
            </For>
          </div>
        )}
      </For>
    </Show>
  );
}

/** A channel, or a thread nested under its parent. */
function ChannelRow(props: { channel: DirectoryChannel }) {
  const c = () => props.channel;
  return (
    <button
      type="button"
      class={isThread(c()) ? `${styles.channel} ${styles.thread}` : styles.channel}
      aria-current={shownChannelId() === c().id}
      data-local-only={c().localAiOnly}
      onClick={() => openChannel(c())}
      onContextMenu={(e) => openContextMenu(e, channelMenu(c()))}
    >
      <Show when={!isThread(c())} fallback={<span class={styles.threadGlyph} aria-hidden="true" />}>
        <span class={styles.channelHash} aria-hidden="true">
          {channelSigil(c())}
        </span>
      </Show>
      <span class={styles.channelName}>{c().name}</span>
      <Show when={isPrivateThread(c())}>
        <span class={styles.privateMark} title={PRIVATE_THREAD_HINT} aria-label="Private thread">
          <Icon name="lock" class={styles.privateIcon} />
        </span>
      </Show>
      <Show when={c().hideInPrivacy}>
        <span class={styles.privateMark} title="Private: hidden, with its threads, while privacy mode is on">
          <EyeIcon class={styles.privateIcon} />
        </span>
      </Show>
      <Show when={c().localAiOnly}>
        <span class={`cp-micro-tag ${styles.policyTag}`} title="Local AI only: hosted AI and Jev skip this channel">
          local
        </span>
      </Show>
      <Show when={syncProgress[c().id]?.phase === 'backfill'}>
        <span class={`cp-micro-tag ${styles.backfillTag}`}>backfill</span>
      </Show>
      <Show when={aiSettings().jev.catchUpBadges && c().notableCount > 0}>
        <span class={`cp-micro-tag ${styles.policyTag}`} title={`${c().notableCount} notable (Jev) since you last opened it`}>
          ★{c().notableCount}
        </span>
      </Show>
      <Show when={c().mentionCount > 0}>
        <span class={styles.mentions} title={`${c().mentionCount} mentioning you since you last opened it`}>
          @{c().mentionCount}
        </span>
      </Show>
      <span class={styles.count} data-new={c().newCount > 0} title={`${c().newCount} new since you last opened it · ${c().messageCount} archived`}>
        {c().newCount}
      </span>
    </button>
  );
}
