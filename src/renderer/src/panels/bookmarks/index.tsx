import { For, Show, onCleanup, onMount } from 'solid-js';
import { editReminder, loadMoreBookmarks, mountSavedMessages, openSavedMessage, refreshSavedMessages, removeSavedMessage, savedBusy, savedMessages, savedTab, setSavedTab } from '@/state/savedMessages';
import { postingUnlocked } from '@/state/posting';
import { now, today } from '@/state/clock';
import { failureNotice } from '@/state/dialogs';
import { HeaderButton } from '@/ui/PanelHeader';
import { Icon } from '@/ui/icons';
import { messageTime } from '@/ui/format';
import { look } from '@/theme/look';
import styles from './Bookmarks.module.css';

/** Keep each spoken action name short while still identifying its message. */
const ACCESSIBLE_SUMMARY_LENGTH = 80;
const actionSubject = (row: import('@shared/savedMessages').SavedMessage): string => `${row.authorName || 'unknown author'}: ${row.summary.slice(0, ACCESSIBLE_SUMMARY_LENGTH)}`;

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
    <ul class={styles.list}><For each={rows()}>{(row) => <li><article class={styles.row} aria-label={`Saved message by ${actionSubject(row)}`}>
      <div class={`${styles.avatar} ${look.avatar}`} aria-hidden="true">{Array.from(row.authorName.trim())[0]?.toLocaleUpperCase() || '?'}</div>
      <div class={styles.post}>
      <header class={styles.meta}>
        <span class={styles.author}>{row.authorName || 'Unknown author'}</span>
        <time class={styles.savedTime} dateTime={row.savedAt} title={`Saved ${new Date(row.savedAt).toLocaleString()}`}>Saved {messageTime(Date.parse(row.savedAt), today())}</time>
      </header>
      <div class={styles.channel}>{row.channelName || 'Unknown channel'}</div>
      <p class={styles.summary}>{row.summary || 'Message unavailable'}</p>
      <Show when={!row.available}><p class={styles.unavailable}>Original message unavailable. Its saved summary is kept by Discord.</p></Show>
      <Show when={row.dueAt}><time class={styles.due} dateTime={row.dueAt!} data-overdue={Date.parse(row.dueAt!) <= now()}>{Date.parse(row.dueAt!) <= now() ? 'Overdue · ' : 'Due · '}{new Date(row.dueAt!).toLocaleString()}</time></Show>
      <div class={styles.actions}>
        <button aria-label={`Open message by ${actionSubject(row)}`} onClick={() => void openSavedMessage(row).catch(failureNotice("Couldn't open the message"))}>Open message</button>
        <Show when={postingUnlocked()}>
          <button aria-label={`${row.dueAt ? 'Edit reminder' : 'Remind me'} for ${actionSubject(row)}`} disabled={savedBusy() || savedMessages().stale} onClick={() => editReminder(row)}>{row.dueAt ? 'Edit reminder' : 'Remind me'}</button>
          <button aria-label={`${row.dueAt ? 'Mark complete' : 'Remove bookmark'} for ${actionSubject(row)}`} disabled={savedBusy() || savedMessages().stale} onClick={() => { const session = savedMessages().session; if (session) void removeSavedMessage(row, session).catch(failureNotice("Couldn't remove the saved message")); }}>{row.dueAt ? 'Mark complete' : 'Remove bookmark'}</button>
        </Show>
      </div>
      </div>
    </article></li>}</For></ul>
    <Show when={savedTab() === 'bookmarks' && savedMessages().hasMore}><button disabled={savedMessages().paging || savedMessages().loading || savedMessages().stale} onClick={() => void loadMoreBookmarks()}>{savedMessages().paging ? 'Loading…' : 'Load more'}</button></Show>
  </section>;
}
