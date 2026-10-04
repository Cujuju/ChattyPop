// Host sentences composed from feature vocabulary rather than plugin-owned prose.
import type { PluginDescriptor, PanelImportance } from '@shared/bundledTypes';
import { andList } from '@shared/lists';
import { placeByAnchor, type PlacementAnchor } from '@shared/anchors';

/** Retention and window descriptions for the active coverage owner, or generic fallbacks. */
export function coverageWording(coverage?: PluginDescriptor['coverage']) {
  const past = coverage?.past ?? 'covered';
  const noun = coverage?.noun;
  return {
    option: `Compress, then remove ${past} text`,
    meta: `${past} text removed`,
    short: `Remove text once ${past}`,
    hint: noun
      ? `Removed text keeps its author, time and attachments, so ${noun} citations still open it. Text no ${noun} covers is never removed.`
      : 'Removed text keeps its author, time and attachments. Text without coverage from an active plugin is never removed.',
    cap: noun
      ? `Over the limit, the oldest messages are compressed first, then (with the ${noun} tier) their ${past} text is removed.`
      : 'Over the limit, the oldest messages are compressed first, then their text is removed if the tier and an active coverage provider allow it.',
    pending: noun ? `the rest is not yet covered by a ${noun}.` : 'the rest is not yet covered by an active plugin.',
    tier: `removing text needs the ${noun ?? 'coverage'} tier above.`,
    covered: noun ? `a ${noun} covers it` : 'an active plugin covers it',
    window: noun
      ? `Since you were last here, after what a ${noun} already covers; at most a week`
      : 'Since you were last here, after already covered time; at most a week',
  };
}

/** Provider and usage descriptions. */
export function aiRunWording(runs?: PluginDescriptor['aiRuns']) {
  const singular = runs?.singular ?? 'AI run';
  const plural = runs?.plural ?? 'AI runs';
  return {
    singular,
    plural,
    provider: runs ? `${runs.active} provider` : 'AI provider',
    title: `Only ChattyPop's own ${plural} in this window. The percentage is your whole plan, including other apps.`,
    empty: `No ${plural} yet`,
    overview: 'Turn providers on and pick the model each one uses. Each feature chooses its provider in its own settings.',
    /** What ChattyPop's AI calls are, in a sentence about their cost. */
    requests: runs?.plural ?? 'requests',
  };
}

/** Phone section vocabulary, supplied in the same order as the drawer. */
export interface PhoneOverview {
  noun: string;
  does?: string;
}

/** Phone capabilities describe only the sections that are available. */
export function phoneOverview(sections: readonly PhoneOverview[]): string {
  const nouns = andList([...sections.map((section) => section.noun), 'the archive']);
  const actions = andList(sections.flatMap((section) => section.does ?? []));
  const actionText = actions ? `, ${actions}, and` : ', and';
  return `Read ${nouns} on your phone${actionText} post from the Archive.`;
}

/** Encrypted content contributed by active owners, in declaration order. */
export function encryptionHint(nouns: readonly string[]): string {
  return `${andList(['Messages', ...nouns, 'settings'])} are encrypted on disk; the key is protected by your Windows sign-in, so only this Windows account can open the archive. Attachment files are not encrypted.`;
}

/** Titles and emphasis supplied by panel metadata, in panel order. */
export interface ThemePanel {
  title: string;
  importance?: PanelImportance;
}

/** Theme explanations follow the panels that are actually available. */
export function themeHints(panels: readonly ThemePanel[]) {
  const primary = panels.filter((panel) => panel.importance === 'primary').map((panel) => panel.title);
  const reference = panels.filter((panel) => panel.importance === 'reference').map((panel) => panel.title);
  const lit = primary.length ? `${andList(primary)} ${primary.length === 1 ? 'is' : 'are'} lit` : 'Primary panels are lit';
  const dim = reference.length ? `${andList(reference)} ${reference.length === 1 ? 'dims' : 'dim'}` : 'reference panels dim';
  const lift = primary.length ? `${andList(primary)} ${primary.length === 1 ? 'lifts' : 'lift'}` : 'Primary panels lift';
  return {
    spotlight: `Graphite with a mint accent, IBM Plex type. ${lit}; ${dim}.`,
    tide: `Soft slate, rounded spaced cards, Atkinson Hyperlegible type. ${lift}; reference panels recede.`,
  };
}

/** Settings → Jev's switch groups, in page order: the host's vocabulary, which plugins' switch rows name. */
export const JEV_FEATURE_GROUPS = ['Alerts', 'Summaries', 'Links', 'Messages & search', 'Tools'] as const;
export type JevFeatureGroup = (typeof JEV_FEATURE_GROUPS)[number];

/**
 * Settings → Jev's switch order: `host` switches in order, plugins' placed by their declared anchors (else appended),
 * then grouped in JEV_FEATURE_GROUPS order. A switch `groupOf` gives no group has no row.
 */
export function orderJevFeatures(
  host: readonly string[],
  plugins: readonly { key: string; anchor?: PlacementAnchor }[],
  groupOf: (key: string) => JevFeatureGroup | undefined,
): string[] {
  const anchors = new Map(plugins.map((f) => [f.key, f.anchor]));
  const placed = placeByAnchor(host, plugins.map((f) => f.key), (key) => key, (key) => anchors.get(key));
  return JEV_FEATURE_GROUPS.flatMap((group) => placed.filter((key) => groupOf(key) === group));
}

/** Query-specific runtime-option guidance or the host's generic explanation. */
export const optionsNote = (query: { optionsNote?: string }): string =>
  query.optionsNote ?? 'The options come from the run, so only the question and threshold can change.';
