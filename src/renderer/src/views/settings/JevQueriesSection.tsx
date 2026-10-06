import { For, Show, createMemo } from 'solid-js';
import { SegButton, SegGroup } from '@cujuju/solidjs-seg-buttons';
import { JEV_QUERY_GROUPS, effectiveJevQuery, type JevQueryDef } from '@shared/jevQueries';
import { jevQueryOverrides } from '@/state/jevQueries';
import { aiSettings } from '@/state/preferences';
import { jevFeatureOn } from '@shared/settings';
import { queries, selected, setSelected, jevView, setJevView, jevQueryFilter as filter, jevQuerySearch as search, setJevQueryFilter as setFilter, setJevQuerySearch as setSearch, type JevQueryFilter as Filter, type JevView } from '@/state/jevNavigation';
import { Icon } from '@/ui/icons';
export { showJevQuery, jevView } from '@/state/jevNavigation';
import { Select } from '@/ui/Select';
import { JevQueryEditor } from './JevQueryEditor';
import { PageHead } from './SettingsLayout';
import styles from './JevQueriesSection.module.css';

const TYPE_TAG = { noul: 'Y/N', choice: 'Pick', score: 'Score' } as const;
const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'on', label: 'On' },
  { value: 'edited', label: 'Edited' },
] as const satisfies readonly { value: Filter; label: string }[];
/** Picks the Jev page's view; in both views' heads. */
export function JevViewSwitch() {
  return (
    <SegGroup role="radiogroup" ariaLabel="Jev view" value={jevView()} onChange={(v: JevView) => setJevView(v)}>
      <SegButton value="features" label="Features" size="md" />
      <SegButton value="queries" label="Queries" size="md" />
    </SegGroup>
  );
}

/** Shows grouped/filterable built-in queries beside persistent editors. */
export function JevQueriesSection() {
  const isOn = (d: JevQueryDef): boolean => d.features.some((f) => jevFeatureOn(aiSettings().jev, f));
  const isEdited = (d: JevQueryDef): boolean => d.id in jevQueryOverrides();
  const query = (d: JevQueryDef) => effectiveJevQuery(d, jevQueryOverrides());
  const visible = createMemo(() => {
    const words = search().trim().toLowerCase();
    return queries().filter(
      (d) =>
        (filter() === 'all' || (filter() === 'on' ? isOn(d) : isEdited(d))) &&
        (!words || d.label.toLowerCase().includes(words) || query(d).question.toLowerCase().includes(words)),
    );
  });
  const inGroup = (g: string) => visible().filter((d) => d.group === g);
  const onCount = () => queries().filter(isOn).length;
  const editedCount = () => queries().filter(isEdited).length;
  return (
    <section class="cp-settings-page" aria-labelledby="jev-queries-heading">
      <PageHead
        id="jev-queries"
        title="Jev"
        lede="Every question the app asks Jev: what it reads, what it returns, and when its answer counts."
        right={
          <>
            <span class={styles.counts}>
              {queries().length} queries · {onCount()} on · {editedCount()} edited
            </span>
            <JevViewSwitch />
          </>
        }
      />
      <div class={styles.tools}>
        <label class={styles.search}>
          <Icon name="search" class={styles.searchIcon} />
          <input class={styles.searchInput} type="search" aria-label="Find a query" placeholder="Find a query or words in its question" value={search()} onInput={(e) => void setSearch(e.currentTarget.value)} />
        </label>
        <SegGroup role="radiogroup" ariaLabel="Show" value={filter()} onChange={(v: Filter) => setFilter(v)}>
          <For each={FILTERS}>{(f) => <SegButton value={f.value} label={f.label} size="md" />}</For>
        </SegGroup>
      </div>
      <div class={`cp-settings-split ${styles.split}`}>
        <nav class={styles.list} aria-label="Jev queries">
          <For each={JEV_QUERY_GROUPS}>
            {(g) => (
              <Show when={inGroup(g).length}>
                <div class={styles.group} data-group={g}>
                  <h3 class={styles.groupHead}>
                    <span class="cp-group-swatch" />
                    {g}
                    <span class={styles.groupCount}>
                      {queries().filter((d) => d.group === g && isOn(d)).length} of {queries().filter((d) => d.group === g).length} on
                    </span>
                  </h3>
                  <For each={inGroup(g)}>
                    {(d) => (
                      <button type="button" class={styles.row} aria-current={selected()?.id === d.id ? 'true' : undefined} onClick={() => setSelected(d.id)}>
                        <span class={styles.dot} data-on={isOn(d)} title={isOn(d) ? 'On' : 'Off: the feature or built-in rule that asks it is off'} />
                        <span class={styles.rowLabel}>{d.label}</span>
                        <span class="cp-visually-hidden">{isOn(d) ? ', on' : ', off'}</span>
                        <Show when={isEdited(d)}>
                          <span class={styles.editedDot} title="Edited" />
                          <span class="cp-visually-hidden">, edited</span>
                        </Show>
                        <span class={styles.typeTag}>{TYPE_TAG[query(d).type]}</span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            )}
          </For>
          <Show when={!visible().length}>
            <p class={styles.empty}>No query matches.</p>
          </Show>
        </nav>
        <div class={styles.picker}>
          <Select value={selected()?.id ?? ''} options={queries().map((d) => ({ value: d.id, label: `${d.group} · ${d.label}` }))} label="Query" onChange={setSelected} />
        </div>
        {/* Keyed: switching queries remounts the editor with that query's saved version. */}
        <Show when={selected()} keyed>
          {(def) => <JevQueryEditor def={def} />}
        </Show>
      </div>
    </section>
  );
}
