import { For, Show, batch, createEffect, createMemo, createSignal, on, onCleanup, onMount } from 'solid-js';
import type { ArchiveMessage, UnreadMark } from '@shared/contract';
import { FORUM_CHANNEL_TYPE } from '@shared/discord';
import { MS_PER_MIN } from '@shared/units';
import { archiveChannelId, archiveDensity, archiveLoads, archiveOpening, archiveState, atNewest, focusMessageId, loadNewer, loadOlder, openArchive, openRestoredArchive } from '@/state/archive';
import { attachFiles } from '@/state/composer';
import { dismissUnreadBanner, unreadBanner, watchArchive } from '@/state/lastRead';
import { firstUnreadAbove } from '@/state/lastReadRules';
import { listen } from '@/ui/listen';
import { editingId } from '@/state/ownMessages';
import { postingUnlocked } from '@/state/posting';
import { archivedChannels, channelById } from '@/state/directory';
import { isDmChannel, isReadOnlyDm, type DmChannel } from '@/state/dmRules';
import { DayDivider, dayLabel } from '@/ui/DayDivider';
import { JumpToNewest } from '@/ui/JumpToNewest';
import { UnreadBanner } from '@/ui/UnreadBanner';
import { onUserScrollNewer } from '@/ui/scrollIntent';
import { createShown, createWindowFocused } from '@/ui/seen';
import { overlayOpen } from '@/state/overlay';
import { inCompanion } from '@/state/ui';
import type { PanelId } from '@/panels/titles';
import { chatFooterItems } from '@/plugins/slots';
import { createTallestBox } from '@/ui/tallestBox';
import { HOST_FOOTER } from './archiveFooter';
import { NotArchived, NotArchivingBar } from './DmState';
import { MessageRow } from './MessageRow';
import { TypingLine } from './TypingLine';
import { createFollowBottom } from '@/ui/followBottom';
import { createVirtualLog } from '@/ui/virtualLog';
import { VirtualRows } from '@/ui/VirtualRows';
import styles from './Archive.module.css';

/** Row-height guesses before measurement (rows are measured once drawn): a message with its author line, one grouped
 * under the previous, a day divider. Closer guesses leave less to correct as rows are measured mid-scroll. */
const ESTIMATED_ROW_PX = 44;
const ESTIMATED_GROUPED_PX = 26;
const ESTIMATED_DAY_PX = 32;
/** Load older messages when the top is within this many rows. */
const LOAD_OLDER_THRESHOLD_ROWS = 10;

type Row = { kind: 'day'; key: string; label: string } | { kind: 'msg'; key: string; message: ArchiveMessage; grouped: boolean };

/** The layout panel the Archive is the body of (the phone's Archive section shares its id). */
const CHAT_PANEL: PanelId = 'chat';

/** Consecutive messages from one author within this gap share one avatar and name (cozy layout). */
const GROUP_GAP_MS = 7 * MS_PER_MIN;

/** ChattyPop's offline rendering of the archive for one channel. */
export function ArchiveView() {
  const rows = createMemo<Row[]>(() => {
    const out: Row[] = [];
    let lastDay = '';
    let prev: ArchiveMessage | undefined;
    for (const m of archiveState.items) {
      const label = dayLabel(m.ts);
      const newDay = label !== lastDay;
      if (newDay) out.push({ kind: 'day', key: `day-${m.id}`, label });
      lastDay = label;
      const grouped = !newDay && prev !== undefined && prev.author.id === m.author.id && m.ts - prev.ts < GROUP_GAP_MS && m.replyToId === null;
      out.push({ kind: 'msg', key: m.id, message: m, grouped });
      prev = m;
    }
    return out;
  });
  // The footer column's height as drawn (typing line and items): it lies over the log (Archive.module.css), so the log
  // ends that far above its bottom edge and its overlays sit above it. A remount (keyed on the channel) re-observes.
  const footer = createTallestBox();

  // `log` is declared below (it reads vlog.holding); only read once rows are measured.
  const vlog = createVirtualLog({
    rows,
    estimatePx: (r) => (r.kind === 'day' ? ESTIMATED_DAY_PX : r.grouped ? ESTIMATED_GROUPED_PX : ESTIMATED_ROW_PX),
    olderThresholdRows: LOAD_OLDER_THRESHOLD_ROWS,
    loadOlder,
    following: () => log.following(),
    hasOlder: () => !archiveState.reachedStart,
    // After a jump, the window may stop short of the newest message: page newer ones in toward it.
    hasNewer: () => !atNewest(),
    loadNewer,
    layoutKey: archiveDensity,
    // The footer lies over the log's bottom: the log ends above it, its own top padding clearing the newest row.
    endPadPx: footer.height,
  });

  const channels = () => archivedChannels({ threads: true });
  const current = () => channels().find((c) => c.id === archiveChannelId());
  /** A DM open without archiving on (docs/dms.md §3.6): 'stopped' shows its history read-only, 'never' an offer to archive it. */
  const openDm = (): DmChannel | undefined => {
    const c = channelById(archiveChannelId() ?? '');
    return c && isDmChannel(c) ? c : undefined;
  };
  const unarchivedDm = (): DmChannel | undefined => {
    const c = openDm();
    return c?.dm.archived !== 'on' ? c : undefined;
  };
  const dmIn = (state: DmChannel['dm']['archived']): DmChannel | undefined => (unarchivedDm()?.dm.archived === state ? unarchivedDm() : undefined);
  /** The channel the composer posts to; a forum holds only posts (threads), and a group left or a message request takes none. */
  const postable = () => {
    const c = current();
    return c && c.kind !== FORUM_CHANNEL_TYPE && !isReadOnlyDm(c) ? c : undefined;
  };
  // Files dropped anywhere on the view attach to the composer's draft, as in Discord; none while posting is locked.
  const [dropping, setDropping] = createSignal(false);
  const dropTarget = () => (postingUnlocked() ? postable() : undefined);
  const hasFiles = (e: DragEvent): boolean => e.dataTransfer?.types.includes('Files') === true;

  // Nothing selected yet: reopen the last channel shown, else the first archived one.
  createEffect(() => openRestoredArchive(channels()));

  // Follows new messages unless the user scrolled up, the window doesn't reach the newest (a jump far back), or a jumped-to
  // message is held in view.
  // On the phone, nor while the Archive is off screen (the app in the background, another section shown), so what
  // arrives meanwhile stays below where the owner left off.
  const [offScreen, setOffScreen] = createSignal(false);
  const log = createFollowBottom(() => !atNewest() || vlog.holding() || offScreen());

  // The open last placed (held or scrolled to the newest): until then the rows and following may be the last open's.
  const [placed, setPlaced] = createSignal(archiveLoads());
  // After every open (channel switch or jump): hold the focused message centered, following again once the user is back
  // at the bottom; with none, go to the newest.
  createEffect(
    on(archiveLoads, (n) => {
      queueMicrotask(() => {
        const focus = focusMessageId();
        if (vlog.holdRow(focus)) log.detach();
        else if (!focus) log.scrollToNewest();
        setPlaced(n);
      });
    }),
  );
  /** The last open is loaded and placed: the rows and following are its own. */
  const settled = (): boolean => !archiveOpening() && placed() === archiveLoads();
  /** The newest message the owner can see: the last row, while the view follows the bottom of a settled open. */
  const seenNewest = (): string | undefined => (settled() && log.following() ? archiveState.items.at(-1)?.id : undefined);

  // The message being edited comes into view (Up may pick one scrolled away); one opened from another panel is focused instead.
  createEffect(
    on(editingId, (id) => {
      if (id !== null) vlog.scrollToKey(id);
    }),
  );

  const jumpToNewest = async (): Promise<void> => {
    const channelId = archiveChannelId();
    // A jump far back loads only a window around its message; reload the newest page first.
    if (!atNewest() && channelId) await openArchive(channelId);
    else {
      vlog.holdRow(null);
      log.scrollToNewest();
    }
  };

  // The open channel's last-read mark moves while the view is on screen; it shows what was unread when the channel came on.
  let root!: HTMLDivElement;
  let scroller: HTMLDivElement | undefined;
  /** The owner can look at the Archive: set once the view is on the page. */
  let lookable: () => boolean = () => false;
  onMount(() => {
    const shown = createShown(root, () => CHAT_PANEL);
    const focused = createWindowFocused();
    // Read only while the owner can look at it: on screen, the window focused, nothing over the chat area.
    lookable = () => shown() && focused() && !overlayOpen();
    if (inCompanion) {
      createEffect(
        on(shown, (now) => {
          if (!now) return void setOffScreen(true);
          if (!offScreen()) return;
          // Back on screen: follow again only from the bottom, before following resumes and scrolls there.
          batch(() => {
            log.detach();
            setOffScreen(false);
          });
        }, { defer: true }),
      );
    }
    watchArchive(lookable, seenNewest);
    // After the rows are drawn, measured or moved (startOf tracks every re-layout; shift translates them): positions
    // are read from the page.
    createEffect(() => {
      const b = unreadBanner();
      void [lookable(), settled(), archiveState.items.length, vlog.log.keys(), vlog.extent(), vlog.log.shift(), b && vlog.log.startOf(b.firstId)];
      requestAnimationFrame(checkBanner);
    });
  });
  /** The banner points up to its first unread: once that is on screen, or below the view, it has nothing to point to. */
  const checkBanner = (): void => {
    const b = unreadBanner();
    if (!b || !scroller?.isConnected || !lookable() || !settled()) return;
    const row = scroller.querySelector(`[data-row-key="${CSS.escape(b.firstId)}"]`);
    const rowTop = row ? row.getBoundingClientRect().top : null;
    if (!firstUnreadAbove(b, archiveState.items, vlog.log.keys(), rowTop, scroller.getBoundingClientRect().top)) dismissUnreadBanner();
  };
  const jumpToUnread = (mark: UnreadMark): void => {
    dismissUnreadBanner();
    void openArchive(mark.channelId, mark.firstId);
  };

  return (
    // Structural geometry only: the scroller must own the remaining height for virtualization to work.
    <div
      ref={root}
      class={styles.root}
      data-dropping={dropping()}
      style={{ display: 'flex', 'flex-direction': 'column', 'min-height': 0, position: 'relative', '--cp-composer-box-h': `${footer.height()}px` }}
      onDragOver={(e) => {
        if (!dropTarget() || !hasFiles(e)) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(e) => {
        setDropping(false);
        const c = dropTarget();
        if (!c || !hasFiles(e)) return;
        e.preventDefault();
        attachFiles(c.id, [...(e.dataTransfer?.files ?? [])]);
      }}
    >
      <Show when={channels().length > 0 || unarchivedDm()} fallback={<p class="cp-panel-empty">Opt in a channel to start the archive.</p>}>
        <Show when={dmIn('stopped')}>{(c) => <NotArchivingBar channel={c()} />}</Show>
        {/* The log's own box, so "Jump to newest" sits over the log, above the composer. */}
        <div style={{ position: 'relative', display: 'flex', 'flex-direction': 'column', flex: '1 1 0', 'min-height': 0 }}>
          <div
            class={styles.scroller}
            ref={(el) => {
              scroller = el;
              // Scrolling, and the view resizing, move the banner's first unread against it.
              listen(el, 'scroll', checkBanner, { passive: true });
              const resized = new ResizeObserver(() => checkBanner());
              resized.observe(el);
              onCleanup(() => resized.disconnect());
              vlog.ref(el);
              log.ref(el);
              onUserScrollNewer(el, dismissUnreadBanner);
            }}
            onScroll={() => void vlog.onScroll()}
            style={{ flex: '1 1 0', 'min-height': 0, 'overflow-y': 'auto' }}
          >
            <VirtualRows log={vlog} class={styles.canvas}>
              {(row) => (
                <Show
                  when={row().kind === 'day'}
                  fallback={
                    <MessageRow
                      message={(row() as Extract<Row, { kind: 'msg' }>).message}
                      grouped={(row() as Extract<Row, { kind: 'msg' }>).grouped}
                      density={archiveDensity()}
                      focused={focusMessageId() === row().key}
                      editing={editingId() === row().key}
                    />
                  }
                >
                  <DayDivider label={(row() as Extract<Row, { kind: 'day' }>).label} />
                </Show>
              )}
            </VirtualRows>
          </div>
          <Show when={unreadBanner()}>
            {(mark) => <UnreadBanner count={mark().count} sinceTs={mark().firstTs} onJump={() => jumpToUnread(mark())} onDismiss={dismissUnreadBanner} />}
          </Show>
          <Show when={!log.following()}>
            <JumpToNewest label="Jump to newest message" onClick={() => void jumpToNewest()} />
          </Show>
          {/* Over the log, which stays mounted (its virtual list keeps its element): nothing is stored to show. */}
          <Show when={dmIn('never')}>{(c) => <NotArchived channel={c()} />}</Show>
        </div>
        {/* The footer column: who is typing (a read, so always), then the slot's items. Keyed on the id: each directory
            refetch makes new channel objects. */}
        <Show when={postable()?.id} keyed>
          <div ref={footer.observe} class={styles.footer}>
            <TypingLine />
            <For each={chatFooterItems(HOST_FOOTER)}>
              {(item) => <item.Component channel={postable()!} measure={footer.observe}/>}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
}
