import { Match, Show, Switch } from 'solid-js';
import { SegButton, SegGroup } from '@cujuju/solidjs-seg-buttons';
import { bindDiscordSlot, chatSource, discordSidebar, setDiscordSidebar, type ChatSource } from '@/state/chat';
import { archiveChannelId, showArchive, showLive } from '@/state/archive';
import { selecting, startSelecting, stopSelecting } from '@/state/messageSelection';
import { overlayOpen } from '@/state/overlay';
import { onServerScreen } from '@/state/ui';
import { ArchiveView } from './ArchiveView';
import { DiscordSignIn } from './DiscordSignIn';
import { discordSession, relayRunning, signInDismissed } from '@/state/discordLogin';
import { HeaderButton, PanelHeader, headerStyles as hs } from '@/ui/PanelHeader';
import styles from './Chat.module.css';

export function ChatPanel() {
  /** Off the server's screen, a signed-out server's Discord is signed in from here (or the archive read as is). */
  const signingIn = (): boolean => !onServerScreen && ((discordSession() === 'signed-out' && !signInDismissed()) || relayRunning());
  return (
    // Structural geometry only: the live slot must take all remaining height (the native view is sized to it).
    <section class={styles.root} aria-label="Chat" style={{ display: 'grid', 'grid-template-rows': 'auto minmax(0, 1fr)' }}>
      <PanelHeader section="chat" title="Chat">
        <div class={hs.actions}>
          <Show when={chatSource() === 'live'}>
            <SidebarToggles />
          </Show>
          <Show when={chatSource() === 'archive' && !signingIn() && archiveChannelId()}>
            <HeaderButton aria-pressed={selecting()} title="Pick messages to copy or export" onClick={() => (selecting() ? stopSelecting() : startSelecting())}>
              Select
            </HeaderButton>
          </Show>
          {/* Off the server's screen (a remote desktop) there is no live client to switch to. */}
          <Show when={onServerScreen}>
            <SegGroup role="radiogroup" ariaLabel="Chat source" value={chatSource()} onChange={(v: ChatSource) => (v === 'archive' ? showArchive() : showLive())}>
              <SegButton value="archive" label="Archive" size="sm" />
              <SegButton value="live" label="Live" size="sm" class={styles.live} />
            </SegGroup>
          </Show>
        </div>
      </PanelHeader>
      <Switch>
        <Match when={chatSource() === 'live'}>
          {/* Empty slot: the native Discord view is drawn over it by the main process. */}
          <div class={styles.liveSlot} ref={(el) => bindDiscordSlot(el, () => chatSource() === 'live' && !overlayOpen())} />
        </Match>
        <Match when={chatSource() === 'archive'}>
          <Show when={signingIn()} fallback={<ArchiveView />}>
            <DiscordSignIn />
          </Show>
        </Match>
      </Switch>
    </section>
  );
}

/** Live client columns: hide the servers; collapse the channels to an edge that opens on hover. Chevrons point the way each click moves. */
function SidebarToggles() {
  const serversLabel = (): string => (discordSidebar().serversHidden ? 'Show servers' : 'Hide servers');
  const channelsLabel = (): string => (discordSidebar().channelsCollapsed ? 'Pin channels open' : 'Collapse channels (hover the edge to open)');
  return (
    <>
      <button
        type="button"
        class={hs.iconAction}
        aria-pressed={discordSidebar().serversHidden}
        aria-label={serversLabel()}
        title={serversLabel()}
        onClick={() => setDiscordSidebar({ ...discordSidebar(), serversHidden: !discordSidebar().serversHidden })}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="6" cy="6" r="2" />
          <circle cx="6" cy="12" r="2" />
          <circle cx="6" cy="18" r="2" />
          <path d={discordSidebar().serversHidden ? 'M14 8l4 4-4 4' : 'M18 8l-4 4 4 4'} />
        </svg>
      </button>
      <button
        type="button"
        class={hs.iconAction}
        aria-pressed={discordSidebar().channelsCollapsed}
        aria-label={channelsLabel()}
        title={channelsLabel()}
        onClick={() => setDiscordSidebar({ ...discordSidebar(), channelsCollapsed: !discordSidebar().channelsCollapsed })}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 6h9M3 12h9M3 18h9" />
          <path d={discordSidebar().channelsCollapsed ? 'M17 8l4 4-4 4' : 'M21 8l-4 4 4 4'} />
        </svg>
      </button>
    </>
  );
}