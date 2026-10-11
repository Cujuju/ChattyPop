import { For, Show, onCleanup, onMount } from 'solid-js';
import { editReminder, loadMoreBookmarks, mountSavedMessages, openSavedMessage, refreshSavedMessages, removeSavedMessage, savedBusy, savedMessages, savedTab, setSavedTab } from '@/state/savedMessages';
import { postingUnlocked } from '@/state/posting';
import { now, today } from '@/state/clock';
import { failureNotice } from '@/state/dialogs';
import { HeaderButton } from '@/ui/PanelHeader';
import { Icon } from '@/ui/icons';
import { avatarUrl } from '@shared/media';
import type { SavedMessage } from '@shared/savedMessages';
import { channelById, channelSigil, directory } from '@/state/directory';
import { Markdown } from '@/ui/Markdown';
import { messageTime } from '@/ui/format';
import { look } from '@/theme/look';
import styles from './Bookmarks.module.css';

/** Keep each spoken action name short while still identifying its message. */
const ACCESSIBLE_SUMMARY_LENGTH = 80;
const actionSubject = (row: SavedMessage): string => `${row.authorName || 'unknown author'}: ${row.summary.slice(0, ACCESSIBLE_SUMMARY_LENGTH)}`;

/** A saved post keeps its channel context visible, with the same avatar gutter and compact actions as chat. */
function SavedPost(props: { row: SavedMessage }) {
  const row = () => props.row;
  const channel = () => channelById(row().channelId);
  const channelName = () => channel() ? `${channelSigil(channel()!)}${channel()!.name}` : row().channelName || 'Channel unavailable';
  const guildName = () => directory().find((guild) => guild.id === (channel()?.guildId ?? row().guildId))?.name;
  const disabled = () => savedBusy() || savedMessages().stale;
  const remindLabel = () => row().dueAt ? 'Edit reminder' : 'Remind me';
  const removeLabel = () => row().dueAt ? 'Mark complete' : 'Remove bookmark';
  return <article class={styles.row} aria-label={`Saved message by ${actionSubject(row())}`}>
    <header class={styles.context}>
      <div class={styles.destination} title={`${channelName()}${guildName() ? ` · ${guildName()}` : ''}`}>
        <span class={styles.channel}>{channelName()}</span>
        <Show when={guildName()}>{(name) => <span class={styles.guild}>{name()}</span>}</Show>
      </div>
      <div class={styles.actions}>
        <button type="button" class={`${styles.action} ${look.iconButton}`} data-variant="window" title="Open message" aria-label={`Open message by ${actionSubject(row())}`}
          onClick={() => void openSavedMessage(row()).catch(failureNotice("Couldn't open the message"))}><Icon name="external" /></button>
        <Show when={postingUnlocked()}>
          <button type="button" class={`${styles.action} ${look.iconButton}`} data-variant="window" title={remindLabel()} aria-label={`${remindLabel()} for ${actionSubject(row())}`} disabled={disabled()}
            onClick={() => editReminder(row())}><Icon name="clock" /></button>
          <button type="button" class={`${styles.action} ${look.iconButton}`} data-variant="window" title={removeLabel()} aria-label={`${removeLabel()} for ${actionSubject(row())}`} disabled={disabled()} data-remove={!row().dueAt}
            onClick={() => { const session = savedMessages().session; if (session) void removeSavedMessage(row(), session).catch(failureNotice("Couldn't remove the saved message")); }}><Icon name={row().dueAt ? 'check' : 'trash'} /></button>
        </Show>
      </div>
    </header>
    <div class={`${styles.avatar} ${look.avatar}`} aria-hidden="true">
      <Show when={row().author} fallback={<Icon name="person" />}>
        {(author) => <img data-avatar src={avatarUrl(author().id, author().avatar)} alt="" loading="lazy" />}
      </Show>
    </div>
    <div class={styles.post}>
      <div class={styles.meta}>
        <span class={styles.author}>{row().authorName || 'Unknown author'}</span>
        <time class={styles.savedTime} dateTime={row().savedAt} title={`Saved ${new Date(row().savedAt).toLocaleString()}`}>Saved {messageTime(Date.parse(row().savedAt), today())}</time>
      </div>
      <div class={styles.summary}><Markdown text={row().summary || 'Message unavailable'} /></div>
      <Show when={!row().available}><p class={styles.unavailable}>Original message unavailable. Its saved summary is kept by Discord.</p></Show>
      <Show when={row().dueAt}><time class={styles.due} dateTime={row().dueAt!} data-overdue={Date.parse(row().dueAt!) <= now()}>{Date.parse(row().dueAt!) <= now() ? 'Overdue · ' : 'Due · '}{new Date(row().dueAt!).toLocaleString()}</time></Show>
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
