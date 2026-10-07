// Whether spoilers inside a view show uncovered (Discord's "Show spoiler content"); a message row provides it, covered by default.
import { createContext } from 'solid-js';

export const SpoilersShown = createContext<() => boolean>(() => false);