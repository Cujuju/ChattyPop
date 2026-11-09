// Archive search as a field with a dropdown list: the phone's shell shows it in its header (plugin SDK shell export).
import { Show } from 'solid-js';
import { searchOpen, setSearchOpen } from '@/state/search';
import { inCompanion } from '@/state/ui';
import { listen } from '@/ui/listen';
import { createSearchController } from './searchController';
import { SearchField } from './SearchField';
import { SearchBody } from './SearchBody';
import styles from './Search.module.css';

/** The field, and below it while open, the list (see searchController). The desktop shows search as the Search panel instead. */
export function Search() {
  let root!: HTMLDivElement;
  const search = createSearchController('dropdown');
  // Outside focus/press closes search. Desktop blur-to-nowhere closes; phone keyboard dismissal keeps results available.
  const onFocusOut = (e: FocusEvent): void => {
    const to = e.relatedTarget as Node | null;
    if (to ? !root.contains(to) : !inCompanion) setSearchOpen(false);
  };
  listen(window, 'pointerdown', (e) => searchOpen() && !root.contains(e.target as Node) && setSearchOpen(false), true);

  return (
    <div ref={root} class={styles.root} onFocusOut={onFocusOut}>
      <SearchField search={search} />
      <Show when={searchOpen()}>
        <SearchBody search={search} class={`cp-popover ${styles.results}`} />
      </Show>
    </div>
  );
}
