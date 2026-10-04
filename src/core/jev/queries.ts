// The effective built-in Jev queries (Settings → Jev → Queries): request form, condition, strength and label, from the
// owner's edit or the default. Every built-in Jev call goes through here, so an edit applies wherever the query runs.
import { effectiveJevQuery, jevQueryDef, type JevQueryDef, type JevQueryOverrides } from '@shared/jevQueries';
import type { CustomJevQuestion } from '@shared/jevQuestion';
import { answerValue, type Answer, type Question } from '../ai/decisions';
import type { StoredAnswer } from './messageQuestions';

let overrides: JevQueryOverrides = {};

/** Core init and every save of the 'jevQueries' setting. Invalid entries fall back to defaults when read. */
export function setJevQueryOverrides(v: unknown): void {
  overrides = v && typeof v === 'object' ? (v as JevQueryOverrides) : {};
}

function def(id: string): JevQueryDef {
  const d = jevQueryDef(id);
  if (!d) throw new Error(`Unknown Jev query: ${id}`);
  return d;
}

/** The query as asked now: the owner's valid edit, else the default. */
export const jevQuery = (id: string): CustomJevQuestion => effectiveJevQuery(def(id), overrides);

/** Per-item values: placeholders filled into the question, values added beside it, runtime options (themes). */
export interface QueryFill {
  placeholders?: Record<string, string>;
  vars?: Record<string, unknown>;
  options?: { name: string; description: string }[];
}

/** The request form of a query. Yes/no meanings are sent only when written; an empty one lets Jev use its own. */
export function queryRequest(id: string, fill: QueryFill = {}): Question {
  const q = jevQuery(id);
  let text = q.question.trim();
  for (const [k, v] of Object.entries(fill.placeholders ?? {})) text = text.split(k).join(v);
  const instructions = fill.vars ? { ...fill.vars, question: text } : text;
  switch (q.type) {
    case 'noul': {
      const yes = q.yes.trim();
      const no = q.no.trim();
      return yes || no ? { type: 'noul', instructions, criteria: { true: yes || 'Yes.', false: no || 'No.' } } : { type: 'noul', instructions };
    }
    case 'choice':
      return { type: 'choice', instructions, criteria: Object.fromEntries((fill.options ?? q.options).map((o) => [o.name.trim(), o.description.trim() || null])) };
    case 'score':
      return { type: 'score', instructions, criteria: q.levels.map((l) => l.trim()) };
  }
}

/**
 * Whether an answer meets a question's condition, as a 0–1 strength (null = not met): yes/no at its threshold; a ticked
 * option at its threshold; a score at or above its level (then the chance of that level or higher).
 */
export function specMatch(q: CustomJevQuestion): (a: Answer) => number | null {
  switch (q.type) {
    case 'noul':
      return (a) => (a.type === 'noul' && a.noul >= q.minProbability ? a.noul : null);
    case 'choice':
      return (a) => {
        if (a.type !== 'choice' || !q.alertOn.includes(a.choice)) return null;
        const p = answerValue(a).value;
        // Questions saved before the threshold existed alert on any matching choice.
        return p >= (q.minProbability ?? 0) ? p : null;
      };
    case 'score':
      return (a) => {
        if (a.type !== 'score' || a.score < q.minScore) return null;
        return Object.entries(a.probabilities).reduce((p, [level, v]) => (Number(level) >= Math.ceil(q.minScore) ? p + v : p), 0);
      };
  }
}

/** specMatch for a built-in query; `alertOn` overrides the ticked options (runtime options, e.g. themes). */
export function queryMatch(id: string, a: Answer, alertOn?: string[]): number | null {
  const q = jevQuery(id);
  return specMatch(alertOn && q.type === 'choice' ? { ...q, alertOn } : q)(a);
}

/** A rank query's 0–1 strength: the yes probability, or the score's position between its lowest and highest level. */
export function queryStrength(id: string, a: Answer): number | null {
  const q = jevQuery(id);
  if (a.type === 'noul') return a.noul;
  if (a.type === 'score' && q.type === 'score') return q.levels.length > 1 ? a.score / (q.levels.length - 1) : null;
  return null;
}

/** A pick-one query's chosen option: always for a query without a condition, else only when the condition is met. */
export function queryLabel(id: string, a: Answer): string | null {
  if (a.type !== 'choice') return null;
  return def(id).condition === null || queryMatch(id, a) !== null ? a.choice : null;
}

/** queryMatch for an answer as jev_judgments stored it (a score keeps only its level, so it compares the level). */
export function storedMatch(id: string, s: StoredAnswer): boolean {
  const q = jevQuery(id);
  switch (q.type) {
    case 'noul':
      return s.label === null && s.value >= q.minProbability;
    case 'choice':
      return s.label !== null && q.alertOn.includes(s.label) && s.value >= q.minProbability;
    case 'score':
      return s.label === null && s.value >= q.minScore;
  }
}

/** SQL with named parameters, merged into a statement's own named values. */
export interface SqlPart {
  sql: string;
  params: Record<string, unknown>;
}

/** `values` as named parameters `@<prefix><i>`, and the comma list that references them. */
function named(prefix: string, values: unknown[]): { list: string; params: Record<string, unknown> } {
  const params = Object.fromEntries(values.map((v, i) => [`${prefix}${i}`, v]));
  return { list: Object.keys(params).map((k) => `@${k}`).join(',') || 'NULL', params };
}

/** storedMatch as SQL over a jev_judgments row alias, for counts. `prefix` keeps its parameter names unique. */
export function storedMatchSql(id: string, alias: string, prefix: string): SqlPart {
  const q = jevQuery(id);
  const min = `${prefix}min`;
  switch (q.type) {
    case 'noul':
      return { sql: `(${alias}.label IS NULL AND ${alias}.value >= @${min})`, params: { [min]: q.minProbability } };
    case 'choice': {
      const on = named(`${prefix}on`, q.alertOn);
      return { sql: `(${alias}.label IN (${on.list}) AND ${alias}.value >= @${min})`, params: { ...on.params, [min]: q.minProbability } };
    }
    case 'score':
      return { sql: `(${alias}.label IS NULL AND ${alias}.value >= @${min})`, params: { [min]: q.minScore } };
  }
}

/**
 * A stored answer's 0–1 strength as SQL, for ordering: a yes probability; a score's position between its lowest and
 * highest level; a pick-one's probability when a ticked option was chosen, else its complement.
 */
export function storedStrengthSql(id: string, alias: string, prefix: string): SqlPart {
  const q = jevQuery(id);
  switch (q.type) {
    case 'noul':
      return { sql: `${alias}.value`, params: {} };
    case 'choice': {
      const on = named(`${prefix}on`, q.alertOn);
      return { sql: `(CASE WHEN ${alias}.label IN (${on.list}) THEN ${alias}.value ELSE 1 - ${alias}.value END)`, params: on.params };
    }
    case 'score':
      return { sql: `(${alias}.value / @${prefix}top)`, params: { [`${prefix}top`]: Math.max(1, q.levels.length - 1) } };
  }
}

/** Identifies the effective versions of some queries, for caches built from their answers. */
export const queryFingerprint = (ids: string[]): string => JSON.stringify(ids.map(jevQuery));
