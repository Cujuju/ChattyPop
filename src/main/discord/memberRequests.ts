// Asks Discord for a server's members matching typed text, as its client does for `@` autocomplete: gateway op 8
// (REQUEST_GUILD_MEMBERS) on the client's own socket. The GUILD_MEMBERS_CHUNK answer arrives through the tap.
import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { diag } from '../diagnostics';
import type { GatewayTap } from './gatewayTap';

const REQUEST_GUILD_MEMBERS_OP = 8;
/** Discord's client asks for this many per query (its autocomplete limit). */
const MEMBER_REQUEST_LIMIT = 10;
/** Usernames, display names and nicknames are at most this long: longer typed text can't start one. */
const DISCORD_NAME_MAX_CHARS = 32;
/**
 * An unanswered search may be asked again after this long. Discord answers within a second; this allows a slow gateway,
 * and a lost answer (a reconnect) stops blocking that text.
 */
const MEMBER_ANSWER_TIMEOUT_MS = 10_000;
/** CDP handles taken here; released together when the socket is looked up again. */
const OBJECT_GROUP = 'chattypop-gateway';

/** The client's open gateway socket among the page's WebSockets; JSON-encoded only, as the frame sent is JSON. */
const FIND_GATEWAY = `function () {
  return this.find((s) => {
    const u = new URL(s.url);
    return s.readyState === WebSocket.OPEN && /gateway[\\w.-]*\\.discord\\.gg/.test(u.hostname) && (u.searchParams.get('encoding') ?? 'json') === 'json';
  });
}`;
const SEND = `function (frame) {
  if (this.readyState !== WebSocket.OPEN) return false;
  this.send(frame);
  return true;
}`;

type Cdp = Pick<WebContents['debugger'], 'sendCommand'>;

/** A sent search awaiting its GUILD_MEMBERS_CHUNK, matched by the nonce it carried. */
interface Pending {
  key: string;
  expiry: ReturnType<typeof setTimeout>;
}

/**
 * Sends member searches through the client's socket, reached over CDP (the page itself is unchanged). Each server and
 * text is asked once per gateway session once answered, as Discord's client keeps the members it was sent; one in
 * flight isn't asked again. One step runs at a time: a lookup releases the previous handles, which a concurrent send
 * would still be using.
 */
export class MemberRequests {
  private socket: string | null = null;
  private readonly answered = new Set<string>();
  private readonly pending = new Map<string, Pending>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly cdp: Cdp,
    tap: GatewayTap,
  ) {
    tap.on('dispatch', ({ t, d }) => {
      if (t === 'GUILD_MEMBERS_CHUNK') return this.answer(d as { nonce?: string; chunk_index?: number; chunk_count?: number });
      if (t !== 'READY') return;
      // A new session: Discord's answers so far stay archived, the old socket's handle goes.
      void this.serial(async () => {
        this.forget();
        this.socket = null;
        await this.cdp.sendCommand('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => undefined);
      });
    });
  }

  /** Our search's last chunk arrived: that text is answered for the session. */
  private answer(c: { nonce?: string; chunk_index?: number; chunk_count?: number }): void {
    const p = c.nonce === undefined ? undefined : this.pending.get(c.nonce);
    if (!p || (c.chunk_index ?? 0) + 1 < (c.chunk_count ?? 1)) return;
    clearTimeout(p.expiry);
    this.pending.delete(c.nonce!);
    this.answered.add(p.key);
  }

  private forget(): void {
    for (const p of this.pending.values()) clearTimeout(p.expiry);
    this.pending.clear();
    this.answered.clear();
  }

  /** False when no open gateway socket was found; the archive's members are then all there is. */
  request(guildId: string, query: string): Promise<boolean> {
    return this.serial(() => this.ask(guildId, query));
  }

  /** Runs `step` after every earlier one has settled. */
  private serial<T>(step: () => Promise<T>): Promise<T> {
    const run = this.queue.then(step);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async ask(guildId: string, query: string): Promise<boolean> {
    const q = query.trim().slice(0, DISCORD_NAME_MAX_CHARS).toLocaleLowerCase();
    const key = `${guildId}:${q}`;
    if (!q || this.answered.has(key) || [...this.pending.values()].some((p) => p.key === key)) return true;
    // Discord echoes the nonce in its answer (at most 32 bytes: a UUID's hex digits).
    const nonce = randomUUID().replaceAll('-', '');
    const frame = JSON.stringify({ op: REQUEST_GUILD_MEMBERS_OP, d: { guild_id: [guildId], query: q, limit: MEMBER_REQUEST_LIMIT, presences: true, nonce } });
    let sent = await this.send(frame);
    if (sent === 'closed') {
      // The cached socket closed (a reconnect): the frame wasn't sent, so look the socket up once more.
      this.socket = null;
      sent = await this.send(frame);
    }
    if (sent === 'sent') this.pending.set(nonce, { key, expiry: setTimeout(() => this.pending.delete(nonce), MEMBER_ANSWER_TIMEOUT_MS) });
    else diag('member-request-not-sent', { reason: sent });
    return sent === 'sent';
  }

  /**
   * 'closed': no open socket, nothing sent. 'unknown': CDP failed mid-call, so the frame may have gone; not retried here
   * (the next keystroke asks again), and the socket is looked up afresh then.
   */
  private async send(frame: string): Promise<'sent' | 'closed' | 'unknown'> {
    try {
      this.socket ??= await this.findSocket();
      if (!this.socket) return 'closed';
      const r = (await this.cdp.sendCommand('Runtime.callFunctionOn', { objectId: this.socket, functionDeclaration: SEND, arguments: [{ value: frame }], returnByValue: true })) as {
        result: { value?: boolean };
      };
      return r.result.value === true ? 'sent' : 'closed';
    } catch (err) {
      this.socket = null;
      diag('member-request-failed', { message: err instanceof Error ? err.message : String(err) });
      return 'unknown';
    }
  }

  private async findSocket(): Promise<string | null> {
    await this.cdp.sendCommand('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP });
    const proto = (await this.cdp.sendCommand('Runtime.evaluate', { expression: 'WebSocket.prototype', objectGroup: OBJECT_GROUP })) as { result: { objectId?: string } };
    if (!proto.result.objectId) return null;
    const all = (await this.cdp.sendCommand('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId, objectGroup: OBJECT_GROUP })) as { objects: { objectId?: string } };
    if (!all.objects.objectId) return null;
    const found = (await this.cdp.sendCommand('Runtime.callFunctionOn', { objectId: all.objects.objectId, functionDeclaration: FIND_GATEWAY, objectGroup: OBJECT_GROUP })) as {
      result: { objectId?: string };
    };
    return found.result.objectId ?? null;
  }
}
