// The Search panel: the archive search field in its header, the list (builder, value picker or results) as its body.
import { createSearchController } from '@/frame/searchController';
import { SearchField } from '@/frame/SearchField';
import { SearchBody } from '@/frame/SearchBody';
import { PanelHeader } from '@/ui/PanelHeader';
import styles from './Search.module.css';

export function SearchPanel() {
  const search = createSearchController('panel');
  return (
    <section class={`cp-panel ${styles.root}`} aria-label="Search">
      <PanelHeader section="search" title="Search">
        {/* Not the tile's grip: presses here select text in the field. */}
        <div class={styles.field} data-twm-no-drag>
          <SearchField search={search} />
        </div>
      </PanelHeader>
      <SearchBody search={search} class={styles.body} />
    </section>
  );
}
