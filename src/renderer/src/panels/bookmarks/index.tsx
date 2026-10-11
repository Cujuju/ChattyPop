import { For, Show, onCleanup, onMount } from 'solid-js';
import { editReminder, loadMoreBookmarks, mountSavedMessages, openSavedMessage, refreshSavedMessages, removeSavedMessage, savedBusy, savedMessages, savedTab, setSavedTab } from '@/state/savedMessages';
import { postingUnlocked } from '@/state/posting';
import { now } from '@/state/clock';
import { failureNotice } from '@/state/dialogs';
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
    <div class={styles.toolbar}><button onClick={() => void refreshSavedMessages()} disabled={savedMessages().loading}>Refresh</button></div>
    <div class={styles.tabs} role="group" aria-label="Saved message type">
      <button aria-pressed={savedTab() === 'bookmarks'} onClick={() => setSavedTab('bookmarks')}>Bookmarks</button>
      <button aria-pressed={savedTab() === 'reminders'} onClick={() => setSavedTab('reminders')}>Reminders</button>
    </div>
    <Show when={savedMessages().error}><p class={styles.error} role="alert">{savedMessages().error}</p></Show>
    <Show when={savedMessages().loading}><p class={styles.empty} role="status">Loading saved messages…</p></Show>
    <Show when={!savedMessages().loading && !savedMessages().error && (savedMessages().stale || (savedTab() === 'bookmarks' && !savedMessages().bookmarksLoaded))}><p class={styles.empty}>Use Refresh to load saved messages for the current account and privacy settings.</p></Show>
    <Show when={!savedMessages().loading && !savedMessages().error && !savedMessages().stale && (savedTab() === 'reminders' || savedMessages().bookmarksLoaded) && rows().length === 0}><p class={styles.empty}>No {savedTab()} yet. Save a message from its context menu.</p></Show>
    <ul class={styles.list}><For each={rows()}>{(row) => <li class={styles.row}>
      <div class={styles.meta}><span>{row.authorName || 'Unknown author'}</span><span>{row.channelName || 'Unknown channel'}</span><time dateTime={row.savedAt}>{new Date(row.savedAt).toLocaleString()}</time></div>
      <p class={styles.summary}>{row.summary || 'Message unavailable'}</p>
      <Show when={!row.available}><p class={styles.empty}>Original message unavailable. Its saved summary is kept by Discord.</p></Show>
      <Show when={row.dueAt}><time class={styles.due} dateTime={row.dueAt!} data-overdue={Date.parse(row.dueAt!) <= now()}>{Date.parse(row.dueAt!) <= now() ? 'Overdue · ' : 'Due · '}{new Date(row.dueAt!).toLocaleString()}</time></Show>
      <div class={styles.actions}>
        <button aria-label={`Open message by ${actionSubject(row)}`} onClick={() => void openSavedMessage(row).catch(failureNotice("Couldn't open the message"))}>Open message</button>
        <Show when={postingUnlocked()}>
          <button aria-label={`${row.dueAt ? 'Edit reminder' : 'Remind me'} for ${actionSubject(row)}`} disabled={savedBusy() || savedMessages().stale} onClick={() => editReminder(row)}>{row.dueAt ? 'Edit reminder' : 'Remind me'}</button>
          <button aria-label={`${row.dueAt ? 'Mark complete' : 'Remove bookmark'} for ${actionSubject(row)}`} disabled={savedBusy() || savedMessages().stale} onClick={() => { const session = savedMessages().session; if (session) void removeSavedMessage(row, session).catch(failureNotice("Couldn't remove the saved message")); }}>{row.dueAt ? 'Mark complete' : 'Remove bookmark'}</button>
        </Show>
      </div>
    </li>}</For></ul>
    <Show when={savedTab() === 'bookmarks' && savedMessages().hasMore}><button disabled={savedMessages().paging || savedMessages().loading || savedMessages().stale} onClick={() => void loadMoreBookmarks()}>{savedMessages().paging ? 'Loading…' : 'Load more'}</button></Show>
  </section>;
}
