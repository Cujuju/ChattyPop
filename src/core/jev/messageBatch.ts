// Several messages in one Jev request (re-runs, catch-up): each question carries its own message's state
// (carriedQuestion), so the request's state is empty.

/** A batched request's state: its questions carry their messages' states. */
export const BATCH_STATE = {};

/** A batched question's id: its subject, then its message's id, so ids stay unique across messages. */
export const batchKey = (subject: string, messageId: string): string => `${subject}_${messageId}`;
