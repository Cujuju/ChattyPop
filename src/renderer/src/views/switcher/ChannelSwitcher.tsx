// Quick channel switcher, Discord's Ctrl+K: type to filter archived channels and DMs, recent ones first; Enter opens
// one in the Archive.
import { For, createEffect, createMemo, createSignal, on } from 'solid-js';
import { openSwitched, switcherChannels } from '@/state/channelRecents';
import { channelLabel, type ArchivedChannel } from '@/state/directory';
import { setSwitcherOpen, switcherOpen } from '@/state/ui';
import { FloatingWindow, WindowHeader } from '@/ui/FloatingWindow';
import { Icon } from '@/ui/icons';
import { createListNav } from '@/ui/listNav';
import chrome from '@/ui/WindowChrome.module.css';
import styles from './ChannelSwitcher.module.css';

/** Channels listed at once; typing narrows the rest. */
const SHOWN = 50;
/** Ids tying the search field to its list for assistive tech; one switcher per document. */
const LIST_ID = 'channel-switcher-list';
const optionId = (c: ArchivedChannel): string => `channel-switcher-${c.id}`;

export function ChannelSwitcher() {
  const [query, setQuery] = createSignal('');
  const matches = createMemo(() => switcherChannels(query()).slice(0, SHOWN));
  let list: HTMLUListElement | undefined;
  const close = (): void => void setSwitcherOpen(false);
  const pick = (c: ArchivedChannel | undefined): void => {
    if (!c) return;
    openSwitched(c);
    close();
  };
  const nav = createListNav(() => matches().length, {
    onEnter: (i) => pick(matches()[i]),
    onEscape: close,
    activeEl: () => list?.querySelector('[data-active="true"]'),
    stopPropagation: true,
  });
  // Each opening starts empty, on the channel to go back to.
  createEffect(
    on(switcherOpen, (open) => {
      if (!open) return;
      setQuery('');
      nav.setActive(0);
    }),
  );
  createEffect(on(query, () => nav.setActive(0), { defer: true }));

  return (
    <FloatingWindow id="channel-switcher" open={switcherOpen()} class={`${chrome.dialog} ${styles.window}`} aria-label="Switch channel" onClose={close}>
      <WindowHeader title="Switch channel" classes={chrome} closeLabel="Close" onClose={close} />
      <div class={styles.body}>
        <label class={styles.search}>
          <Icon name="search" class={styles.searchIcon} />
          <input
            class={styles.searchField}
            type="search"
            placeholder="Search channels and direct messages"
            aria-label="Search channels and direct messages"
            aria-controls={LIST_ID}
            aria-activedescendant={matches()[nav.active()] ? optionId(matches()[nav.active()]!) : undefined}
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={nav.onKey}
            autofocus
          />
        </label>
        <ul id={LIST_ID} class={styles.list} role="listbox" aria-label="Channels" ref={list}>
          <For each={matches()} fallback={<li class={styles.empty}>No archived channel or direct message matches “{query().trim()}”.</li>}>
            {(c, i) => (
              <li
                id={optionId(c)}
                class={styles.row}
                role="option"
                aria-selected={nav.active() === i()}
                data-active={nav.active() === i()}
                onMouseEnter={() => nav.setActive(i())}
                onClick={() => pick(c)}
              >
                <span class={styles.name}>{channelLabel(c)}</span>
                <span class={styles.place}>{c.guildName}</span>
              </li>
            )}
          </For>
        </ul>
      </div>
    </FloatingWindow>
  );
}
