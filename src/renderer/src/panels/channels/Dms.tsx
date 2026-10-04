import { For, Match, Show, Switch, createSignal } from 'solid-js';
import { openChannel, shownChannelId } from '@/state/archive';
import { channelMenu } from '@/state/channelPolicy';
import { syncProgress } from '@/state/directory';
import { dismissDmFailure, dmFailure, dmMenu } from '@/state/dmActions';
import { allDms, dmAge, dmFilter, dmList, dmMuted, dmSearch, dmUnread, setDmFilter, setDmSearch, type DmChannel, type DmFilter } from '@/state/dms';
import { openNewMessage } from '@/state/newMessage';
import { postingUnlocked } from '@/state/posting';
import { inCompanion, openContextMenu } from '@/state/ui';
import { EyeIcon } from '@/ui/EyeIcon';
import { FailureNote } from '@/ui/FailureNote';
import { keyedRows } from '@/ui/keyedRows';
import { Icon } from '@/ui/icons';
import { DmFace } from '@/ui/DmFace';
import styles from './Dms.module.css';

const FILTERS: readonly { value: DmFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
  { value: 'groups', label: 'Groups' },
];

/** Rows and fold toggles (data-dm-nav): the arrow keys move focus among them in DOM order. */
const NAV_SELECTOR = '[data-dm-nav]';

/** Moves focus `step` rows from `from` (none: before the first row) within `list`, stopping at either end. */
function moveFocus(list: HTMLElement | undefined, from: Element | null, step: 1 | -1): void {
  const rows = [...(list?.querySelectorAll<HTMLElement>(NAV_SELECTOR) ?? [])];
  const i = from ? rows.indexOf(from as HTMLElement) : -1;
  rows[Math.min(Math.max(i + step, 0), rows.length - 1)]?.focus();
}

/**
 * The sidebar's DMs mode (docs/dms.md §4.1): search, New message, filter chips, then the account's DMs in Discord's order,
 * with Requests and Closed folded at the bottom. On the phone, or while posting is locked, it has no New message.
 */
export function Dms() {
  const emptyText = (): string =>
    dmSearch().trim() || dmFilter() !== 'all'
      ? 'No conversations match.'
      : allDms().length
        ? 'No open conversations.'
        : 'No direct messages yet. They appear once Discord has loaded.';
  let list: HTMLDivElement | undefined;
  const onListKey = (e: KeyboardEvent): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    moveFocus(list, document.activeElement, e.key === 'ArrowDown' ? 1 : -1);
  };
  return (
    <div class={styles.dms}>
      <div class={styles.tools}>
        <label class={styles.search}>
          <Icon name="search" class={styles.searchIcon} />
          <input
            type="search"
            class={styles.searchField}
            placeholder="Find a conversation"
            aria-label="Find a conversation by name or member"
            value={dmSearch()}
            onInput={(e) => setDmSearch(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowDown') return;
              e.preventDefault();
              moveFocus(list, null, 1);
            }}
          />
        </label>
        <Show when={!inCompanion && postingUnlocked()}>
          <button type="button" class={styles.compose} aria-label="New message" title="New message" onClick={openNewMessage}>
            <Icon name="compose" />
          </button>
        </Show>
      </div>
      <div class={styles.chips} role="group" aria-label="Show">
        <For each={FILTERS}>
          {(f) => (
            <button type="button" class={styles.chip} aria-pressed={dmFilter() === f.value} onClick={() => setDmFilter(f.value)}>
              {f.label}
            </button>
          )}
        </For>
      </div>
      <Show when={dmFailure('list')}>{(f) => <FailureNote text={f().text} onDismiss={dismissDmFailure} />}</Show>
      <div class={styles.list} ref={list} onKeyDown={onListKey}>
        <Show when={dmList().list.length > 0} fallback={<p class={styles.empty}>{emptyText()}</p>}>
          <DmRows channels={dmList().list} />
        </Show>
        <Fold label="Requests" channels={dmList().requests} />
        <Fold label="Closed" channels={dmList().closed} />
      </div>
    </div>
  );
}

/** A folded group at the bottom of the list: its toggle with a count, then its rows while open. */
function Fold(props: { label: string; channels: DmChannel[] }) {
  const [open, setOpen] = createSignal(false);
  return (
    <Show when={props.channels.length > 0}>
      <button type="button" class={styles.fold} aria-expanded={open()} data-dm-nav onClick={() => setOpen(!open())}>
        <span class="cp-chevron" aria-hidden="true" />
        {props.label} · {props.channels.length}
      </button>
      <Show when={open()}>
        <DmRows channels={props.channels} />
      </Show>
    </Show>
  );
}

/** Rows keyed by channel id: a directory read makes new objects, and a row must outlive it (focus, arrow keys). */
function DmRows(props: { channels: DmChannel[] }) {
  const rows = keyedRows(() => props.channels);
  return <For each={rows.ids()}>{(id) => <Show when={rows.item(id)}>{(c) => <DmRow channel={c()} />}</Show>}</For>;
}

/** The newest archived message as "Name: text", else why there is none. */
function Preview(props: { channel: DmChannel }) {
  const dm = () => props.channel.dm;
  return (
    <Switch fallback={<span class={styles.preview}>No messages archived</span>}>
      <Match when={dm().archived === 'never'}>
        <span class={styles.preview}>Not archived</span>
      </Match>
      <Match when={dm().preview}>
        {(p) => (
          <span class={styles.preview}>
            <Show when={p().authorName}>
              <span class={styles.previewAuthor}>{p().authorName}:</span>{' '}
            </Show>
            {p().text}
          </span>
        )}
      </Match>
    </Switch>
  );
}

/** One conversation: face, name and age, then its preview with Discord's count and the archive's marks. */
function DmRow(props: { channel: DmChannel }) {
  const c = () => props.channel;
  return (
    <button
      type="button"
      class={styles.row}
      data-dm-nav
      data-dm-row={c().id}
      aria-current={shownChannelId() === c().id}
      data-unread={dmUnread(c())}
      data-muted={dmMuted(c())}
      data-archived={c().dm.archived}
      onClick={() => openChannel(c())}
      // The phone only reads: its rows keep the channel menu.
      onContextMenu={(e) => openContextMenu(e, inCompanion ? channelMenu(c()) : dmMenu(c()))}
    >
      <DmFace channel={c()} />
      <span class={styles.lines}>
        <span class={styles.line}>
          <span class={styles.name}>{c().name}</span>
          <Show when={dmMuted(c())}>
            <span class={styles.muted} title="Muted on Discord">
              <Icon name="bellOff" class={styles.markIcon} />
            </span>
          </Show>
          <span class={styles.age}>{dmAge(c())}</span>
        </span>
        <span class={styles.line}>
          <Preview channel={c()} />
          <Show when={c().hideInPrivacy}>
            <span class={styles.mark} title="Private: hidden while privacy mode is on">
              <EyeIcon class={styles.markIcon} />
            </span>
          </Show>
          <Show when={c().localAiOnly}>
            <span class={`cp-micro-tag ${styles.policyTag}`} title="Local AI only: hosted AI and Jev skip this conversation">
              local
            </span>
          </Show>
          <Show when={syncProgress[c().id]?.phase === 'backfill'}>
            <span class={`cp-micro-tag ${styles.backfillTag}`}>backfill</span>
          </Show>
          <Show when={c().mentionCount > 0}>
            <span class={styles.count} title={`${c().mentionCount} unread on Discord`}>
              {c().mentionCount}
            </span>
          </Show>
          <Show when={c().dm.archived !== 'never'}>
            <span
              class={styles.archivedDot}
              data-archived={c().dm.archived}
              title={c().dm.archived === 'on' ? 'Archived' : 'Not archiving: its history is kept'}
            />
          </Show>
        </span>
      </span>
    </button>
  );
}
