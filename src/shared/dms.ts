// Direct-message writes the renderer asks main for (docs/dms.md §3.5), and what they answer. Kept out of discord.ts,
// which the plugin SDK re-exports.

/** Discord's cap on a group DM's members, the owner included. */
export const GROUP_DM_MAX_MEMBERS = 10;
/** Longest group DM name Discord accepts (its channel name limit). */
export const GROUP_DM_NAME_MAX = 100;

/** Discord's mute lengths: the client's `selected_time_window` values, in seconds; MUTE_UNTIL_UNMUTED has no end. */
export const MUTE_15_MIN_S = 900;
export const MUTE_1_HOUR_S = 3600;
export const MUTE_3_HOURS_S = 10800;
export const MUTE_8_HOURS_S = 28800;
export const MUTE_24_HOURS_S = 86400;
export const MUTE_UNTIL_UNMUTED = -1;
/** The client's mute choices, in its order. */
export const MUTE_WINDOWS = [MUTE_15_MIN_S, MUTE_1_HOUR_S, MUTE_3_HOURS_S, MUTE_8_HOURS_S, MUTE_24_HOURS_S, MUTE_UNTIL_UNMUTED] as const;
export type MuteWindow = (typeof MUTE_WINDOWS)[number];
export const isMuteWindow = (v: unknown): v is MuteWindow => (MUTE_WINDOWS as readonly unknown[]).includes(v);

/** A friend of the signed-in account, from the client's gateway (READY's relationships, RELATIONSHIP_*). */
export interface Friend {
  id: string;
  /** Display name, else username. */
  name: string;
  username: string;
  avatar: string | null;
  /** When they became friends (ms); null when Discord didn't say. */
  since: number | null;
}

/** People an add didn't reach once others were in, and Discord's reason. */
export interface DmAddFailure {
  userIds: string[];
  reason: string;
}

/** Conversation outcomes distinguish opened/created, uncertain non-retryable writes and partial failures. Failed additions retry against the resulting channelId. */
export type DmOutcome = { kind: 'opened' | 'created'; channelId: string; failed?: DmAddFailure } | { kind: 'uncertain' };

/** Shown for an `uncertain` outcome. */
export const DM_UNCERTAIN_TEXT = "Discord didn't confirm it. The conversation may exist already: check Discord before trying again.";

/** A private channel of the signed-in account, as main checks a write against it. */
export interface PrivateChannelFacts {
  kind: number;
  closed: boolean;
  /** Members without self, owner included; null while unknown. */
  recipients: string[] | null;
  ownerId: string | null;
  /** A message request (or spam): read-only until accepted in Discord. */
  request: boolean;
}
