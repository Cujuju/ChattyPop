import { Match, Show, Switch } from 'solid-js';
import { SegButton, SegGroup } from '@cujuju/solidjs-seg-buttons';
import { bindDiscordSlot, chatSource, discordSidebar, setDiscordSidebar, type ChatSource } from '@/state/chat';
import { showArchive, showLive } from '@/state/archive';
import { overlayOpen } from '@/state/overlay';
import { ArchiveView } from './ArchiveView';
import { PanelHeader, headerStyles as hs } from '@/ui/PanelHeader';
import styles from './Chat.module.css';

export function ChatPanel() {
  return (
    // Structural geometry only: the live slot must take all remaining height (the native view is sized to it).
    <section class={styles.root} aria-label="Chat" style={{ display: 'grid', 'grid-template-rows': 'auto minmax(0, 1fr)' }}>
      <PanelHeader section="chat" title="Chat">
        <div class={hs.actions}>
          <Show when={chatSource() === 'live'}>
            <SidebarToggles />
          </Show>
          <SegGroup role="radiogroup" ariaLabel="Chat source" value={chatSource()} onChange={(v: ChatSource) => (v === 'archive' ? showArchive() : showLive())}>
            <SegButton value="archive" label="Archive" size="sm" />
            <SegButton value="live" label="Live" size="sm" class={styles.live} />
          </SegGroup>
        </div>
      </PanelHeader>
      <Switch>
        <Match when={chatSource() === 'live'}>
          {/* Empty slot: the native Discord view is drawn over it by the main process. */}
          <div class={styles.liveSlot} ref={(el) => bindDiscordSlot(el, () => chatSource() === 'live' && !overlayOpen())} />
        </Match>
        <Match when={chatSource() === 'archive'}>
          <ArchiveView />
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