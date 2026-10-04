// Settings → Jev → Queries: read and save the owner's edits to built-in queries, and re-run a per-message one on past messages.
import type { CoreMethods } from '@shared/contract';
import { jevQueryDef, validateJevQuery, type JevQueryOverrides } from '@shared/jevQueries';
import { SETTINGS_KEYS } from '@shared/settings';
import { getSetting, setSetting, type Db } from './db';
import { QUERY } from './jev/questions';
import { setJevQueryOverrides } from './jev/queries';
import { rerunMessages, rerunSubjects } from './jev/rerun';
import type { RuleMatcher } from './rules/matcher';

type Handlers = Pick<CoreMethods, 'jevQueryOverrides' | 'setJevQuery' | 'jevRerunCount' | 'jevRerun'>;

const stored = (db: Db): JevQueryOverrides => {
  const v = getSetting(db, SETTINGS_KEYS.jevQueries);
  return v && typeof v === 'object' ? (v as JevQueryOverrides) : {};
};

/** The meaning query's id before it left Alerts (A2); its stored override moves to QUERY.meaning once. */
const LEGACY_MEANING_QUERY = 'alerts.topicMeaning';

/** Loads the owner's edits so every built-in Jev call uses them. Call at core init. */
export const loadJevQueryOverrides = (db: Db): void => {
  const overrides = stored(db);
  if (Object.hasOwn(overrides, LEGACY_MEANING_QUERY)) {
    if (!Object.hasOwn(overrides, QUERY.meaning)) overrides[QUERY.meaning] = overrides[LEGACY_MEANING_QUERY]!;
    delete overrides[LEGACY_MEANING_QUERY];
    setSetting(db, SETTINGS_KEYS.jevQueries, overrides);
  }
  setJevQueryOverrides(overrides);
};

export function jevQueryHandlers(db: () => Db, matcher: () => RuleMatcher): Handlers {
  return {
    jevQueryOverrides: () => stored(db()),
    setJevQuery: (id, q) => {
      const def = jevQueryDef(id);
      if (!def) throw new Error(`Unknown Jev query: ${id}`);
      if (q) validateJevQuery(def, q);
      const next = { ...stored(db()) };
      if (q) next[id] = q;
      else delete next[id];
      setSetting(db(), SETTINGS_KEYS.jevQueries, next);
      setJevQueryOverrides(next);
    },
    jevRerunCount: (req) => {
      rerunSubjects(db(), req.queryId); // throws for a query that can't re-run
      return rerunMessages(db(), req).length;
    },
    jevRerun: async (req) => {
      const subjects = rerunSubjects(db(), req.queryId);
      const messages = rerunMessages(db(), req);
      const r = await matcher().rejudge(messages, subjects);
      if (messages.length && !r.asked) throw new Error('Nothing was asked: turn on this query’s switch in Settings → Jev (and for rules by meaning, describe one’s subject).');
      return r;
    },
  };
}
