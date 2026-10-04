// The archive's message order: by timestamp, then by id as a number (a snowflake: shorter is smaller, then digits).
// The SQL in core/queries/messages.ts orders the same way.

/** Whether `a` comes before `b`. */
export function messageBefore(a: { ts: number; id: string }, b: { ts: number; id: string }): boolean {
  if (a.ts !== b.ts) return a.ts < b.ts;
  if (a.id.length !== b.id.length) return a.id.length < b.id.length;
  return a.id < b.id;
}
