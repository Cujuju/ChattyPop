// Whether spoilers inside a view show uncovered (Discord's "Show spoiler content"); a message row provides it, covered by default.
import { createContext } from 'solid-js';

export const SpoilersShown = createContext<() => boolean>(() => false);
/** Inline links already covered by their enclosing sender-authored spoiler. */
export const SenderSpoiler = createContext(false);

/** Message identity scopes a link's local mark; senderLinks records links inside Discord spoiler Markdown. */
export const SpoilerMessage = createContext<() => { id: string; senderLinks: ReadonlySet<string> } | null>(() => null);
