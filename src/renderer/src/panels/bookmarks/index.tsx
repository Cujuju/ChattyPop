import { onCleanup } from '@plugin-sdk/renderer/containment';
import { For, Show, createEffect, createMemo, on, onMount } from 'solid-js';
import { HoldIndicator, useHoldAction } from '@cujuju/solidjs-hold-action';
import {
  editReminder, inSavedPlace, loadMoreBookmarks, mountSavedMessages, openSavedMessage, refreshSavedMessages, removeSavedMessage, savedBusy, savedChannelsHidden,
  savedMessages, savedPlace, savedTab, setSavedChannelsHidden, setSavedPlace, setSavedTab, threadParent,
} from '@/state/savedMessages';
import { postingUnlocked } from '@/state/posting';
import { closePanelDialog, inCompanion } from '@/state/ui';
import { createSavedMessagePreview } from '@/state/savedMessagePreviews';
import { now } from '@/state/clock';
import { failureNotice } from '@/state/dialogs';
import { HeaderButton } from '@/ui/PanelHeader';
import { Icon } from '@/ui/icons';
import { avatarUrl } from '@shared/media';
import { DM_GUILD_ID, snowflakeToMs } from '@shared/discord';
import { savedGuildId, type SavedMessage } from '@shared/savedMessages';
import { channelById, channelSigil, directory } from '@/state/directory';
import { Markdown } from '@/ui/Markdown';
import { GuildIcon } from '@/ui/GuildIcon';
import { MessageRow } from '@/ui/MessageRow';
import { PlaceRail, type PlaceCounts } from '@/ui/PlaceRail';
import { clockTime } from '@/ui/format';
import { look } from '@/theme/look';
import styles from './Bookmarks.module.css';

/** Keep each spoken action name short while still identifying its message. */
const ACCESSIBLE_SUMMARY_LENGTH = 80;
const actionSubject = (row: SavedMessage): string => `${row.authorName || 'unknown author'}: ${row.summary.slice(0, ACCESSIBLE_SUMMARY_LENGTH)}`;

/** A short click is inert; a full hold removes the bookmark without a confirmation dialog. */
function RemoveBookmarkButton(props: { row: SavedMessage; disabled: boolean }) {
  let button: HTMLButtonElement | undefined;
  let holdSession: string | null = null;
  const hold = useHoldAction({
    durationMs: 1_000,
    enabled: () => !props.disabled && postingUnlocked(),
    onComplete: () => {
      if (!props.disabled && postingUnlocked() && holdSession && holdSession === savedMessages().session)
        void removeSavedMessage(props.row, holdSession).catch(failureNotice("Couldn't remove the saved message"));
    },
  });
  // The toolkit gates starting a hold; account/read changes also cancel one already in progress.
  createEffect(on([() => props.disabled, () => savedMessages().session, () => savedMessages().revision], () => hold.cancel()));
  const start = (event: PointerEvent) => {
    holdSession = savedMessages().session;
    hold.handlers.onPointerDown(event);
  };
  const label = () => `Hold for 1 second to remove bookmark by ${actionSubject(props.row)}`;
  return <button ref={button} type="button" class={`${styles.action} ${look.button} ${look.text}`} data-variant="raised"
    data-holding={hold.holding()} data-remove="true" disabled={props.disabled} title="Hold for 1 second to remove bookmark" aria-label={label()}
    {...hold.handlers} onPointerDown={start} onPointerCancel={hold.cancel} onBlur={hold.cancel}
    onContextMenu={(event) => event.preventDefault()}
    onClick={(event) => { hold.shouldSuppressClick(); event.preventDefault(); }}
    onKeyDown={(event) => {
      if (event.key === 'Escape') hold.cancel();
      if (event.key !== ' ' && event.key !== 'Enter') return;
      event.preventDefault();
      if (!event.repeat) start(new PointerEvent('pointerdown', { button: 0 }));
    }}
    onKeyUp={(event) => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); hold.cancel(); } }}>
    <Icon name="trash" class={styles.actionIcon} />
    <Show when={hold.holding()}><HoldIndicator progress={hold.progress} shape="rect" strokePlacement="outside" radius={parseFloat(getComputedStyle(button!).borderTopLeftRadius)} /></Show>
  </button>;
}

/** Discord-style saved card: destination and controls above a separate chat post. */
function SavedPost(props: { row: SavedMessage }) {
  const row = () => props.row;
  const preview = createSavedMessagePreview(row);
  const channel = () => channelById(row().channelId);
  const channelName = () => channel() ? `${channelSigil(channel()!)}${channel()!.name}` : row().channelName || 'Channel unavailable';
  const guild = () => directory().find((guild) => guild.id === (channel()?.guildId ?? row().guildId));
  const place = () => {
    const parent = guild()?.channels.find((candidate) => candidate.id === channel()?.parentId);
    return [guild()?.name || (row().guildId ? 'Server unavailable' : 'Direct Messages'), parent?.name].filter(Boolean).join(' › ');
  };
  const postedAt = () => snowflakeToMs(row().messageId);
  const disabled = () => savedBusy() || savedMessages().loading || savedMessages().stale;
  const remindLabel = () => row().dueAt ? 'Edit reminder' : 'Remind me';
  const viewInArchive = () => void openSavedMessage(row()).then(() => closePanelDialog('bookmarks')).catch(failureNotice("Couldn't open the message"));
  return <article class={`${styles.row} ${look.card}`} aria-label={`Saved message by ${actionSubject(row())}`}>
    <header class={`${styles.context} ${look.ruleBelow}`} data-rule="subtle">
      <button type="button" class={styles.destination} title={`Open message in ${channelName()} · ${place()}`} aria-label={`Open message by ${actionSubject(row())}`}
        onClick={viewInArchive}>
        <span class={styles.channelIcon} aria-hidden="true">
          <Show when={guild()?.id !== DM_GUILD_ID && guild()} fallback={<Icon name="conversation" />}>
            {(server) => <GuildIcon id={server().id} name={server().name} icon={server().icon} />}
          </Show>
        </span>
        <Icon name="chevronRight" class={styles.chevron} />
        <span class={styles.destinationText}>
          <span class={styles.channel}>{channelName()}</span>
          <span class={styles.guild}>{place()}</span>
        </span>
      </button>
      <div class={styles.actions}>
        <button type="button" class={`${styles.action} ${look.button} ${look.text}`} data-variant="raised" title="View in archive" aria-label={`View in archive: ${actionSubject(row())}`}
          onClick={viewInArchive}><Icon name="external" class={styles.actionIcon} /></button>
        <Show when={postingUnlocked()}>
          <button type="button" class={`${styles.action} ${look.button} ${look.text}`} data-variant="raised" title={remindLabel()} aria-label={`${remindLabel()} for ${actionSubject(row())}`} disabled={disabled()}
            onClick={() => editReminder(row())}><Icon name="bell" class={styles.actionIcon} /></button>
          <Show when={row().dueAt} fallback={<RemoveBookmarkButton row={row()} disabled={disabled()} />}>
            <button type="button" class={`${styles.action} ${look.button} ${look.text}`} data-variant="raised" title="Mark complete" aria-label={`Mark complete for ${actionSubject(row())}`} disabled={disabled()}
              onClick={() => { const session = savedMessages().session; if (session) void removeSavedMessage(row(), session).catch(failureNotice("Couldn't remove the saved message")); }}><Icon name="check" class={styles.actionIcon} /></button>
          </Show>
        </Show>
      </div>
    </header>
    <Show when={preview()} fallback={<div class={styles.message}>
      <div class={`${styles.avatar} ${look.avatar}`} aria-hidden="true">
        <Show when={row().author} fallback={<Icon name="person" />}>
          {(author) => <img data-avatar src={avatarUrl(author().id, author().avatar)} alt="" loading="lazy" />}
        </Show>
      </div>
      <div class={styles.post}>
        <div class={styles.meta}>
          <span class={styles.author}>{row().authorName || 'Unknown author'}</span>
          <time class={styles.savedTime} dateTime={new Date(postedAt()).toISOString()} title={`${new Date(postedAt()).toLocaleString()} · Saved ${new Date(row().savedAt).toLocaleString()}`}>{clockTime(postedAt())}</time>
        </div>
        <div class={styles.summary}><Markdown text={row().summary || 'Message unavailable'} /></div>
        <SavedDetails row={row()} />
      </div>
    </div>}>
      {(message) => <div class={styles.preview}>
        <MessageRow message={message()} density="cozy" grouped={false} focused={false}>
          <SavedDetails row={row()} />
        </MessageRow>
      </div>}
    </Show>
  </article>;
}

function SavedDetails(props: { row: SavedMessage }) {
  const row = () => props.row;
  return <>
    <Show when={!row().available}><p class={styles.unavailable}>Original message unavailable. Its saved summary is kept by Discord.</p></Show>
    <Show when={row().dueAt}><time class={styles.due} dateTime={row().dueAt!} data-overdue={Date.parse(row().dueAt!) <= now()}>{Date.parse(row().dueAt!) <= now() ? 'Overdue · ' : 'Due · '}{new Date(row().dueAt!).toLocaleString()}</time></Show>
  </>;
}

export function BookmarksPanel() {
  let unmount: (() => void) | undefined;
  onMount(() => { unmount = mountSavedMessages(); });
  onCleanup(() => unmount?.());
  const tabRows = () => savedTab() === 'bookmarks' ? savedMessages().bookmarks : savedMessages().reminders;
  const rows = () => tabRows().filter(inSavedPlace);
  /** The tab's saved messages per server and per channel or thread; `listed` adds a thread's parent, so the rail shows the thread. */
  const tally = createMemo(() => {
    const guilds = new Map<string, number>();
    const channels = new Map<string, number>();
    const listed = new Set<string>();
    const add = (m: Map<string, number>, id: string) => m.set(id, (m.get(id) ?? 0) + 1);
    for (const row of tabRows()) {
      add(guilds, savedGuildId(row));
      add(channels, row.channelId);
      listed.add(row.channelId).add(threadParent(row.channelId) ?? row.channelId);
    }
    return { guilds, channels, listed };
  });
  const counts: PlaceCounts = {
    guild: (id) => tally().guilds.get(id) ?? 0,
    channel: (id) => tally().channels.get(id) ?? 0,
    total: () => tabRows().length,
    label: (n) => `${n} ${savedTab() === 'bookmarks' ? (n === 1 ? 'bookmark' : 'bookmarks') : (n === 1 ? 'reminder' : 'reminders')}`,
  };
  return <div class={styles.placed}>
    {/* The desktop picks a place as Links and AI chat do; the phone lists everything. */}
    <Show when={!inCompanion}>
      <PlaceRail place={savedPlace()} onPlace={(p) => void setSavedPlace(p)} channelsHidden={savedChannelsHidden()} onChannelsHidden={(h) => void setSavedChannelsHidden(h)}
        listsGuild={(g) => tally().guilds.has(g.id)} listsChannel={(c) => tally().listed.has(c.id)} counts={counts} allServers />
    </Show>
  <section class={styles.root} aria-label="Bookmarks and reminders">
    <div class={styles.toolbar}>
      <div class={styles.tabs} role="group" aria-label="Saved message type">
        <button aria-pressed={savedTab() === 'bookmarks'} onClick={() => setSavedTab('bookmarks')}>Bookmarks</button>
        <button aria-pressed={savedTab() === 'reminders'} onClick={() => setSavedTab('reminders')}>Reminders</button>
      </div>
      <HeaderButton variant="icon" aria-label="Refresh saved messages" title="Refresh" onClick={() => void refreshSavedMessages()} disabled={savedMessages().loading}>
        <Icon name="refresh" />
      </HeaderButton>
    </div>
    <Show when={savedMessages().error}><p class={styles.error} role="alert">{savedMessages().error}</p></Show>
    <Show when={savedMessages().indexReadFailed}><p class={styles.error} role="status">Discord could not load saved messages. Existing bookmarks and reminders may be missing. Use Refresh to try again.</p></Show>
    <Show when={savedMessages().loading}><p class={styles.empty} role="status">Loading saved messages…</p></Show>
    <Show when={!savedMessages().loading && !savedMessages().error && (savedMessages().stale || (savedTab() === 'bookmarks' && !savedMessages().bookmarksLoaded))}><p class={styles.empty}>Use Refresh to load saved messages for the current account and privacy settings.</p></Show>
    <Show when={!savedMessages().loading && !savedMessages().error && !savedMessages().indexReadFailed && !savedMessages().stale && (savedTab() === 'reminders' || savedMessages().bookmarksLoaded) && rows().length === 0}><p class={styles.empty}>{tabRows().length ? `No ${savedTab()} here. Pick another place, or All servers.` : `No ${savedTab()} yet. Save a message from its context menu.`}</p></Show>
    <ul class={styles.list}><For each={rows()}>{(row) => <li><SavedPost row={row} /></li>}</For></ul>
    <Show when={savedTab() === 'bookmarks' && savedMessages().hasMore}><button disabled={savedMessages().paging || savedMessages().loading || savedMessages().stale} onClick={() => void loadMoreBookmarks()}>{savedMessages().paging ? 'Loading…' : 'Load more'}</button></Show>
  </section>
  </div>;
}
