import type { PrivacyScope } from '@shared/contract';
import { SNOWFLAKE_ID } from '@shared/discord';

/** Hides privacy-marked entities using live-verified Discord selectors. Text lacking hidden ids, including plain mentions and folder tooltips, remains visible. */
export function privacyCss(scope: PrivacyScope): string {
  // Ids go into selectors, so only snowflakes pass.
  const guilds = scope.guildIds.filter((id) => SNOWFLAKE_ID.test(id));
  const channels = scope.channelIds.filter((id) => SNOWFLAKE_ID.test(id));
  const selectors = [
    // A server in the server rail, and its icon in a folder's preview.
    ...guilds.flatMap((g) => [`[class^="listItem_"]:has([data-list-item-id="guildsnav___${g}"])`, `img[src*="/icons/${g}/"]`]),
    // A channel or thread row in the channel list.
    ...channels.map((c) => `li:has([data-list-item-id="channels___${c}"])`),
    // Any list row linking to a hidden server or channel: DM rows, and messages holding a link or forward from one.
    ...[...guilds, ...channels].flatMap((id) => [`li:has(a[href$="/${id}"])`, `li:has(a[href*="/${id}/"])`]),
  ];
  return selectors.length ? `${selectors.join(',\n')} { display: none !important; }` : '';
}
