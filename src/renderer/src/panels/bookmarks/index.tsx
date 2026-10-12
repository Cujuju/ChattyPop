import { For, Show, createEffect, on, onCleanup, onMount } from 'solid-js';
import { HoldIndicator, useHoldAction } from '@cujuju/solidjs-hold-action';
import { editReminder, loadMoreBookmarks, mountSavedMessages, openSavedMessage, refreshSavedMessages, removeSavedMessage, savedBusy, savedMessages, savedTab, setSavedTab } from '@/state/savedMessages';
import { postingUnlocked } from '@/state/posting';
import { now } from '@/state/clock';
import { failureNotice } from '@/state/dialogs';
import { HeaderButton } from '@/ui/PanelHeader';
import { Icon } from '@/ui/icons';
import { avatarUrl } from '@shared/media';
import { DM_GUILD_ID, snowflakeToMs } from '@shared/discord';
import type { SavedMessage } from '@shared/savedMessages';
import { channelById, channelSigil, directory } from '@/state/directory';
import { Markdown } from '@/ui/Markdown';
import { GuildIcon } from '@/ui/GuildIcon';
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
  return <article class={`${styles.row} ${look.card}`} aria-label={`Saved message by ${actionSubject(row())}`}>
    <header class={`${styles.context} ${look.ruleBelow}`} data-rule="subtle">
      <button type="button" class={styles.destination} title={`Open message in ${channelName()} · ${place()}`} aria-label={`Open message by ${actionSubject(row())}`}
        onClick={() => void openSavedMessage(row()).catch(failureNotice("Couldn't open the message"))}>
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
    <div class={styles.message}>
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
        <Show when={!row().available}><p class={styles.unavailable}>Original message unavailable. Its saved summary is kept by Discord.</p></Show>
        <Show when={row().dueAt}><time class={styles.due} dateTime={row().dueAt!} data-overdue={Date.parse(row().dueAt!) <= now()}>{Date.parse(row().dueAt!) <= now() ? 'Overdue · ' : 'Due · '}{new Date(row().dueAt!).toLocaleString()}</time></Show>
      </div>
    </div>
  </article>;
}

export function BookmarksPanel() {
  let unmount: (() => void) | undefined;
  onMount(() => { unmount = mountSavedMessages(); });
  onCleanup(() => unmount?.());
  const rows = () => savedTab() === 'bookmarks' ? savedMessages().bookmarks : savedMessages().reminders;
  return <section class={styles.root} aria-label="Bookmarks and reminders">
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
    <Show when={!savedMessages().loading && !savedMessages().error && !savedMessages().indexReadFailed && !savedMessages().stale && (savedTab() === 'reminders' || savedMessages().bookmarksLoaded) && rows().length === 0}><p class={styles.empty}>No {savedTab()} yet. Save a message from its context menu.</p></Show>
    <ul class={styles.list}><For each={rows()}>{(row) => <li><SavedPost row={row} /></li>}</For></ul>
    <Show when={savedTab() === 'bookmarks' && savedMessages().hasMore}><button disabled={savedMessages().paging || savedMessages().loading || savedMessages().stale} onClick={() => void loadMoreBookmarks()}>{savedMessages().paging ? 'Loading…' : 'Load more'}</button></Show>
  </section>;
}
