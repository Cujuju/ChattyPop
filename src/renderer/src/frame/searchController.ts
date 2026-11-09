// One archive search's builder state, shared by its field and its list: the phone's dropdown or the Search panel.
import { createEffect, createMemo, createResource, on } from 'solid-js';
import type { SearchHit } from '@shared/contract';
import { searchTokens } from '@/plugins/slots';
import { parseSearchQuery } from '@shared/searchQuery';
import { openArchive } from '@/state/archive';
import { choicesRevision, querySearch, savedSearches, searchFocusPending, searchFocusTaken, searchHits, searchOpen, searchText, setSearchOpen } from '@/state/search';
import { showSearch } from '@/state/searchPanel';
import { createListNav } from '@/ui/listNav';
import { namedChoiceSources, rememberChoice, chipChoice } from './searchChoices';
import { joinQuery, pendingFilter, searchFilters, splitQuery, withChoice, withFilter, type FilterChoice, type PendingFilter, type QueryChip } from './searchFilters';

/** Where the list shows: a dropdown under the field that opens and closes, or a panel body that always shows. */
export type SearchSurface = 'dropdown' | 'panel';

/** The choices offered for one pending value. */
interface OfferedChoices {
  pending: PendingFilter;
  list: readonly FilterChoice[];
  /** choicesRevision when asked: a list from before a privacy change is never shown. */
  revision: number;
}

/** Choices for `pending`, now when its filter has them at hand, else when they arrive (people). */
function offeredChoices(pending: PendingFilter): OfferedChoices | Promise<OfferedChoices> {
  const revision = choicesRevision();
  const list = pending.filter.choices(pending.partial);
  return list instanceof Promise ? list.then((l) => ({ pending, list: l, revision })) : { pending, list, revision };
}

/** The same chips, term for term: the field keeps them (and their looked-up names) while only the draft changes. */
const sameChips = (a: readonly QueryChip[], b: readonly QueryChip[]): boolean => a.length === b.length && a.every((c, i) => c.raw === b[i]!.raw);

/** Empty queries list filters and saved searches; a `key:` being typed offers matching values; results open in the chat. */
export function createSearchController(surface: SearchSurface) {
  let input: HTMLInputElement | undefined;
  let query: HTMLDivElement | undefined;
  const filters = createMemo(() => searchFilters(searchTokens(), namedChoiceSources));
  // A privacy change asks again for the same text.
  const pending = createMemo(() => (choicesRevision(), pendingFilter(searchText(), filters())));
  const [offered] = createResource(pending, offeredChoices);
  /** The latest choices for the filter being typed; while newer ones load, the previous list stays to avoid a flash (so not keyedResource). */
  const choices = (): readonly FilterChoice[] => {
    const o = offered.error ? undefined : offered.latest;
    return o && o.pending.filter === pending()?.filter && o.revision === choicesRevision() ? o.list : [];
  };
  /** Only choices for exactly what is typed now may be picked. */
  const current = (): boolean => !offered.error && offered.latest?.pending === pending();
  /** A pending value shows its picker until it is typed and matches nothing, when its results show instead. */
  const picking = (): boolean => {
    const p = pending();
    return !!p && (p.partial === '' || choices().length > 0 || (offered.loading && !!p.filter.named));
  };
  const mode = (): 'filters' | 'value' | 'results' => (searchText().trim() === '' ? 'filters' : picking() ? 'value' : 'results');
  const pluginKeys = createMemo(() => searchTokens().map((t) => t.key));
  const problems = () => parseSearchQuery(searchText(), pluginKeys()).problems;
  /** The query as the field shows it: finished filters as chips, then the draft typed in the input. */
  const split = createMemo(() => splitQuery(searchText(), pluginKeys()));
  const chips = createMemo(() => split().chips, undefined, { equals: sameChips });
  const draft = (): string => split().draft;
  /** The list shows: the dropdown while open, the panel always. */
  const showing = (): boolean => surface === 'panel' || searchOpen();

  /** Replaces the query, keeping the field focused and the list showing. */
  const edit = (text: string): void => {
    querySearch(text);
    setActive(0);
    if (surface === 'dropdown') setSearchOpen(true);
    input?.focus();
  };
  const pick = (choice: FilterChoice | undefined): void => {
    const p = pending();
    if (!p || !choice || !current()) return;
    rememberChoice(p.filter.key, choice);
    edit(withChoice(searchText(), p, choice));
  };
  const removeChip = (chip: QueryChip): void => edit(joinQuery(chips().filter((c) => c !== chip), draft()));
  const choiceFor = (chip: QueryChip) => chipChoice(chip, filters().find((f) => f.key === chip.key), chips());
  /** Typing sets the draft; a term it finishes moves into a chip, so the input then shows the draft alone. */
  const onDraft = (el: HTMLInputElement): void => {
    edit(joinQuery(chips(), el.value));
    if (el.value !== draft()) el.value = draft();
  };
  /** Backspace at the draft's start removes the last chip, as Discord's does. */
  const onBackspace = (e: KeyboardEvent): void => {
    if (e.key !== 'Backspace' || input?.selectionStart !== 0 || input.selectionEnd !== 0 || !chips().length) return;
    e.preventDefault();
    removeChip(chips().at(-1)!);
  };
  /** Runs a saved search, by Enter or a click alike: its filters finished as chips. */
  const openSaved = (text: string): void => {
    showSearch(text);
    setActive(0);
  };
  /** The dropdown closes and the field lets go (the phone puts the field away too); the panel keeps both. */
  const close = (): void => {
    if (surface === 'panel') return;
    setSearchOpen(false);
    input?.blur();
  };
  /** Shows the hit's message in the chat (which takes focus). The dropdown closes; the panel stays with its results. */
  const open = (hit: SearchHit | undefined): void => {
    if (!hit) return;
    void openArchive(hit.channelId, hit.messageId);
    close();
  };
  const rowCount = (): number => {
    if (mode() === 'filters') return filters().length + savedSearches().length;
    if (mode() === 'value') return choices().length;
    return searchHits().length;
  };
  const { active, setActive, onKey } = createListNav(rowCount, {
    onEnter: (i) => {
      if (mode() === 'results') open(searchHits()[i]);
      else if (mode() === 'value') pick(choices()[i]);
      else if (i < filters().length) edit(withFilter(searchText(), filters()[i]!.key));
      else if (savedSearches()[i - filters().length]) openSaved(savedSearches()[i - filters().length]!);
    },
    onEscape: () => (surface === 'panel' ? input?.blur() : close()),
    activeEl: () => document.getElementById(`search-row-${active()}`),
  });
  // A new chip may overflow the field: keep the draft in view.
  createEffect(on(chips, () => query && (query.scrollLeft = query.scrollWidth), { defer: true }));
  // The search shortcut or a "search for this" action asked for the field.
  createEffect(() => {
    if (!searchFocusPending() || !input) return;
    input.focus();
    searchFocusTaken();
  });

  return {
    surface,
    setInput: (el: HTMLInputElement) => (input = el),
    setQuery: (el: HTMLDivElement) => (query = el),
    focus: () => input?.focus(),
    filters, pending, choices, mode, problems, chips, draft, showing, rowCount,
    active, setActive, onKey,
    edit, pick, removeChip, choiceFor, onDraft, onBackspace, openSaved, close, open,
  };
}

export type SearchController = ReturnType<typeof createSearchController>;
