import { openPanel } from './layout';
import { querySearch, requestSearchFocus, setSearchOpen } from './search';
import { inCompanion } from './ui';

/** Opens the desktop panel or companion dropdown, then requests focus. */
export function focusSearch(): void {
  if (inCompanion) setSearchOpen(true);
  else openPanel('search');
  requestSearchFocus();
}

/** The SDK's setSearchOpen: the phone opens or closes its dropdown; the desktop opens the panel (closing is the panel's own). */
export function setSearchShown(open: boolean): void {
  if (inCompanion) setSearchOpen(open);
  else if (open) focusSearch();
}

/** Shows a whole query from outside the field (a saved search, a person's messages): its terms finished, as chips. */
export function showSearch(query: string): void {
  querySearch(query.trim() ? `${query.trim()} ` : '');
  focusSearch();
}
