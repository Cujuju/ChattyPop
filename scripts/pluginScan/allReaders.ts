// The all-data allowlist (docs/plugin-architecture.md §3): plugin files, by `<plugin folder>/<path>`, that may read
// `archive_all_*` views, each with its reason. File permissions, never host-table exemptions.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** The host's grants: the public marketplace's plugins. */
export const ALL_READERS: Readonly<Record<string, string>> = {
  'alerts/core/dedupe.ts': 'Background duplicate judgment reads original text regardless of privacy.',
  'exchange/core/exchange.ts': 'Owner export preserves every selected message and stored attachment.',
  'links/core/feed.ts': 'Visible links retain unfiltered share counts, preview candidates and scope metadata.',
  'links/core/judge.ts': 'Background link judging and cleanup cover the whole link index.',
  'links/core/xPosts.ts': 'Fetching linked posts on arrival covers every message.',
  'plans/core/plans.ts': 'Channel metadata remains unchanged after the message view filters plans; extraction reads the full text of each hit (AI input).',
  'stats/core/stats.ts': 'Scope metadata and URL shares stay unfiltered; message counts remain private.',
  'summaries/core/summarize.ts': 'Default summary scope includes every opted-in channel.',
  'summaries/core/summaryLog.ts': 'Summary AI input and mention names were unfiltered.',
  'tags/core/questions.ts': 'Explicit Jev range work includes hidden messages and child channels.',
  'tags/core/service.ts': 'Manual tagging emits the complete original message to rule triggers.',
  'tags/core/store.ts': 'Live Discord chips include hidden history; tagged lists use filtered messages.',
  'imagetext/core/reader.ts': 'Image queueing and reading cover every message and attachment, privacy mode or not.',
  'imagetext/core/store.ts': 'The queue waits on attachment downloads whatever privacy mode hides.',
  'transcription/core/store.ts': 'Audio queueing and processing cover all attachments.',
  'translation/core/queue.ts': 'Translation queueing covers every message’s parts, privacy mode or not, as Image text’s and Transcription’s.',
};

const HOST_LIST = 'scripts/pluginScan/allReaders.ts';
/** A plugin repo holds its plugins in this folder (`plugins/<id>/`). */
const PLUGINS_FOLDER = 'plugins';
/** A plugin repo's own grants, beside its plugins folder, shaped as ALL_READERS; that repo's owner answers for them. */
export const REPO_ALL_READERS = 'all-readers.json';

/** Each granted file for the plugin in `pluginDir`, mapped to the list granting it: the host's, then its repo's. */
export function allReadersFor(pluginDir: string): ReadonlyMap<string, string> {
  const grants = new Map(Object.keys(ALL_READERS).map((key) => [key, HOST_LIST]));
  const pluginsDir = dirname(pluginDir);
  if (basename(pluginsDir) !== PLUGINS_FOLDER) return grants;
  const file = join(dirname(pluginsDir), REPO_ALL_READERS);
  if (!existsSync(file)) return grants;
  const listed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const valid =
    typeof listed === 'object' &&
    listed !== null &&
    !Array.isArray(listed) &&
    Object.values(listed).every((reason) => typeof reason === 'string' && reason.trim() !== '');
  if (!valid) throw new Error(`${file}: expected { "<plugin folder>/<path>": "<reason>" }`);
  for (const key of Object.keys(listed)) if (!grants.has(key)) grants.set(key, REPO_ALL_READERS);
  return grants;
}
