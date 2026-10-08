// Optional member enrichment. Production uses the passive tap; it never discovers or owns Discord's gateway socket.

/** A separately validated transport owns its request policy; absence means local suggestions only. */
export type MemberSearchTransport = (guildId: string, query: string) => Promise<boolean>;

/** Keeps the IPC/SDK contract available without touching the embedded page on startup, reconnect, or typing. */
export class MemberRequests {
  constructor(private readonly transport?: MemberSearchTransport) {}

  /** False when optional enrichment is unavailable; already observed members remain searchable. */
  request(guildId: string, query: string): Promise<boolean> {
    return this.transport?.(guildId, query) ?? Promise.resolve(false);
  }
}
