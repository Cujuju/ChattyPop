// Built-in query catalog defines defaults/editability. Owner edits persist by id under jevQueries; core resolves effective queries.
import { placeByAnchor, type PlacementAnchor } from '../anchors';
import { bundledJevQueries, jevQueryAnchor } from '../bundledPlugins';
import type { JevFeature } from '../settings';
import { validateCondition, validateJevSpec, type ConditionErrors, type CustomJevQuestion } from '../jevQuestion';
import { JEV_QUERY_GROUPS, type JevQueryGroup } from './groups';
import { HOST_JEV_QUERIES } from './host';

export { JEV_QUERY_GROUPS, type JevQueryGroup };

/** Query modes constrain editability: decision/display free; rank yes/no or score; labels pick-one; fixed options/levels preserve identities; dynamic options restrict question/threshold edits. */
export type JevQueryUse = 'decision' | 'rank' | 'labels' | 'fixed-options' | 'fixed-levels' | 'dynamic-options' | 'display';

/** A Jev query; `F` names its switches: stamped in the catalog, a plugin's own keys (or the host's) in its descriptor. */
export interface JevQueryDef<F extends string = JevFeature> {
  id: string;
  group: JevQueryGroup;
  label: string;
  /** The Settings → Jev switches that run it; any one is enough. */
  features: readonly F[];
  /** What Jev reads alongside the question: the names the question may refer to in backticks. */
  sees: string;
  use: JevQueryUse;
  /** Explanation of the runtime-supplied options, when this query uses them. */
  optionsNote?: string;
  /** Per-item markers the app fills in (e.g. {k} = which message); the question must keep them. */
  placeholders?: readonly string[];
  /** Values the app adds next to the question (e.g. `topic` = the topic's description). */
  vars?: readonly string[];
  /** What a met condition does, as a verb ("Alert", "Keep"); null = the condition isn't used. */
  condition: string | null;
  /** A bundled plugin's per-message query: the jev_judgments subject it answers under (re-running it on past messages). */
  subject?: string;
  /** Asked about each message as it arrives, so it can be re-run on past messages. */
  perMessage?: boolean;
  defaults: CustomJevQuestion;
}

/** Orders queries by groups, host order and catalog anchors, including omitted plugins. Unplaced plugin queries follow host entries in build order. */
export const orderJevQueries = (
  host: readonly JevQueryDef[],
  plugins: readonly JevQueryDef[],
  anchorOf: (id: string) => PlacementAnchor | undefined,
): JevQueryDef[] =>
  JEV_QUERY_GROUPS.flatMap((group) =>
    placeByAnchor(host.filter((q) => q.group === group), plugins.filter((q) => q.group === group), (q) => q.id, anchorOf),
  );

/** The host's queries and this build's plugins', in Settings order (orderJevQueries). */
export const JEV_QUERIES: readonly JevQueryDef[] = orderJevQueries(HOST_JEV_QUERIES, bundledJevQueries(), jevQueryAnchor);

export const jevQueryDef = (id: string): JevQueryDef | undefined => JEV_QUERIES.find((q) => q.id === id);

/** The owner's edits by query id. */
export type JevQueryOverrides = Record<string, CustomJevQuestion>;

/** The types a query may take. */
export function allowedTypes(def: JevQueryDef): CustomJevQuestion['type'][] {
  switch (def.use) {
    case 'decision':
    case 'display':
      return ['noul', 'choice', 'score'];
    case 'rank':
      return ['noul', 'score'];
    default:
      return [def.defaults.type];
  }
}

const QUERY_CONDITION_ERRORS: ConditionErrors = {
  threshold: 'Pick a threshold between 0 and 100%.',
  options: 'Tick at least one option that counts.',
  level: 'Pick the level at which it counts.',
};
/** Question types as the editor names them. */
const TYPE_NAME: Record<CustomJevQuestion['type'], string> = { noul: 'yes/no', choice: 'pick one', score: 'a score' };

/** Rejects unaskable edits and incompatible answer contracts with editor messages. */
export function validateJevQuery(def: JevQueryDef, q: CustomJevQuestion): void {
  if (!allowedTypes(def).includes(q.type)) throw new Error(`This query must stay ${allowedTypes(def).map((t) => TYPE_NAME[t]).join(' or ')}.`);
  for (const p of def.placeholders ?? []) if (!q.question.includes(p)) throw new Error(`Keep ${p} in the question: the app fills it in for each item.`);
  const d = def.defaults;
  if (def.use === 'fixed-options' && d.type === 'choice' && q.type === 'choice') {
    const names = (o: { name: string }[]): string => o.map((x) => x.name.trim()).join('\n');
    if (names(q.options) !== names(d.options)) throw new Error('The option names are read by the app; only their meanings can change.');
  }
  if (def.use === 'fixed-levels' && d.type === 'score' && q.type === 'score' && q.levels.length !== d.levels.length) {
    throw new Error(`Keep ${d.levels.length} levels: the app reads the level.`);
  }
  if (def.use === 'dynamic-options') {
    if (!q.question.trim()) throw new Error('Write the question Jev should answer.');
  } else validateJevSpec(q);
  if (def.condition === null) return;
  // dynamic-options: the options, and so which count, come from the run.
  validateCondition(q, QUERY_CONDITION_ERRORS, def.use !== 'dynamic-options');
}

/** Upper bound on messages one re-run asks about: bounds cost (~$0.00002 each) and time (4 requests in flight). */
export const JEV_RERUN_MAX = 5000;

/** Re-asks a per-message query about past messages: one channel (with its threads) or every archived one, in a time range. */
export interface JevRerunRequest {
  queryId: string;
  /** null = every archived channel (local-AI-only ones are always left out). */
  channelId: string | null;
  fromTs: number;
  toTs: number;
}

export interface JevRerunResult {
  asked: number;
  failed: number;
  costUsd: number | null;
}

/** The effective query: the owner's valid edit, else the default. */
export function effectiveJevQuery(def: JevQueryDef, overrides: JevQueryOverrides): CustomJevQuestion {
  const o = overrides[def.id];
  if (!o) return def.defaults;
  try {
    validateJevQuery(def, o);
    return o;
  } catch {
    return def.defaults; // an edit made invalid by an app update falls back rather than breaking the feature
  }
}
