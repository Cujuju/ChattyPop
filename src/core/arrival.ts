// How and when a message's text reached ChattyPop, and whether that counts as live.
import { MS_PER_MIN } from '@shared/units';

/** A stored message's text, as matching sees it. */
export interface TextMessage {
  id: string;
  channelId: string;
  authorId: string;
  ts: number;
  content: string;
  /** Text of the posts and pages it links to (previews, fetched X posts), one per line; '' when none. */
  linked: string;
}

/** Only recent gateway text and recent live checks notify or run live-only actions. Backfill, catch-up and re-asks populate the inbox. */
export const LIVE_WINDOW_MS = 2 * MS_PER_MIN;

/** When a check's text reached ChattyPop live, the time of the check; null for backfill, catch-up and re-asks. */
export type LiveAt = number | null;
/** Live actions require checks within the live window, including delayed Jev answers. */
export const isLive = (liveAt: LiveAt): boolean => liveAt !== null && Date.now() - liveAt <= LIVE_WINDOW_MS;

/** How a message text reached ChattyPop: the live gateway tap, a history fetch (catch-up, backfill, re-check), or a file import. */
export const ARRIVAL = { gateway: 'gateway', sync: 'sync', import: 'import' } as const;
export type Arrival = (typeof ARRIVAL)[keyof typeof ARRIVAL];

/** One arrival of a message's text: how, when ChattyPop got it, and whether it replaced earlier text (an edit). */
export interface Arrived {
  via: Arrival;
  at: number;
  edit: boolean;
}

/** Live only when the gateway delivered it within the live window of its sending; a fetched page never is, however fresh. */
export const liveAtOf = (m: TextMessage, a: Arrived): LiveAt => (a.via === ARRIVAL.gateway && a.at - m.ts <= LIVE_WINDOW_MS ? Date.now() : null);
