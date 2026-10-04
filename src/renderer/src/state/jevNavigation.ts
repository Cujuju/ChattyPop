// Query selection and navigation shared by the Jev page and plugin editors.
import { createSetting } from '@plugin-sdk/renderer/settings';
import { SETTINGS_KEYS } from '@shared/settings';
import { oneOf, textOrNull } from '@shared/normalize';
import { JEV_QUERIES, type JevQueryDef } from '@shared/jevQueries';
import { jevQueryPlugin } from '@shared/bundledPlugins';
import { offeredQueries, shownQuery } from './jevCatalog';
import { pluginActive } from './plugins';
import { setSettingsSection } from './ui';

/** The catalog, a bundled plugin's queries only while it is on. Reactive. */
export const queries = (): readonly JevQueryDef[] => offeredQueries(JEV_QUERIES, jevQueryPlugin, pluginActive);

/** Settings' tab id for the Jev page, whose Queries view this is. */
const JEV_TAB = 'jev';

/** The picked query, restored on start, and set from other pages' links. */
const [picked, setPicked] = createSetting<string>(SETTINGS_KEYS.jevQuery, queries()[0]!.id, (v) => textOrNull(v) ?? queries()[0]!.id);
/** Picks the query the Queries view opens. */
export const setSelected = (id: string): void => void setPicked(id);
/** The open query: the picked one while the catalog offers it, else the first offered. Reactive. */
export const selected = (): JevQueryDef | undefined => shownQuery(queries(), picked());

/** The Jev page's view: its features (switches, cost, models) or every query it asks. */
const JEV_VIEWS = ['features', 'queries'] as const;
export type JevView = (typeof JEV_VIEWS)[number];
export const [jevView, setJevView] = createSetting<JevView>(SETTINGS_KEYS.jevView, JEV_VIEWS[0], (v) => oneOf(JEV_VIEWS, v, JEV_VIEWS[0]));

/** The Queries list's filters, restored on start: words to find, and which queries to show. */
export const JEV_QUERY_FILTERS = ['all', 'on', 'edited'] as const;
export type JevQueryFilter = (typeof JEV_QUERY_FILTERS)[number];
export const [jevQuerySearch, setJevQuerySearch] = createSetting<string>(SETTINGS_KEYS.jevQuerySearch, '', (v) => textOrNull(v, false) ?? '');
export const [jevQueryFilter, setJevQueryFilter] = createSetting<JevQueryFilter>(SETTINGS_KEYS.jevQueryFilter, JEV_QUERY_FILTERS[0], (v) => oneOf(JEV_QUERY_FILTERS, v, JEV_QUERY_FILTERS[0]));

/** Opens Settings → Jev → Queries on one query (e.g. from a Jev feature that asks it). */
export function showJevQuery(id: string): void {
  setSelected(id);
  setJevView('queries');
  setSettingsSection(JEV_TAB);
}

