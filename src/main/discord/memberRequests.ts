// Searches guild members through client gateway op 8. GUILD_MEMBERS_CHUNK responses arrive through the tap.
import type { WebContents } from 'electron';
import { sleep } from '@shared/async';
import { MS_PER_S } from '@shared/units';
import { diag } from '../diagnostics';
import type { GatewayTap } from './gatewayTap';

const REQUEST_GUILD_MEMBERS_OP = 8;
/** Discord's client asks for this many per query (its autocomplete limit). */
const MEMBER_REQUEST_LIMIT = 10;
/** Usernames, display names and nicknames are at most this long: longer typed text can't start one. */
const DISCORD_NAME_MAX_CHARS = 32;
/** Discord closes a connection that sends more than this many gateway frames in a window, the client's own included. */
const GATEWAY_SENDS_PER_WINDOW = 120;
const GATEWAY_SEND_WINDOW_MS = 60 * MS_PER_S;
/** Searches share half the gateway budget across desktop windows and the phone; sustained searches wait for room. */
export const MEMBER_REQUESTS_PER_WINDOW = GATEWAY_SENDS_PER_WINDOW / 2;
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

/**
 * Serializes CDP socket access, caches sent server/query pairs per gateway session, respects rolling send budgets and
 * RATE_LIMITED waits, and drops queued searches replaced by newer searches.
 */
export class MemberRequests {
  private socket: string | null = null;
  /** When Discord's RATE_LIMITED lets the next search go. */
  private limitedUntil = 0;
  /** When our searches in the current window went, oldest first. */
  private readonly sentAt: number[] = [];
  /** The newest search asked for each server, by sequence number. */
  private readonly newest = new Map<string, number>();
  private asked = 0;
  private readonly sentQueries = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly cdp: Cdp,
    private readonly tap: Pick<GatewayTap, 'on' | 'own'>,
    private readonly perWindow = MEMBER_REQUESTS_PER_WINDOW,
  ) {
    tap.on('dispatch', ({ t, d }) => {
      if (t === 'RATE_LIMITED') return this.limited(d as { opcode?: number; retry_after?: number });
      if (t !== 'READY' && t !== 'RESUMED') return;
      // Refresh the socket handle on READY and RESUMED; eager lookup avoids a heap walk during the first search.
      void this.serial(async () => {
        if (t === 'READY') this.forget();
        this.socket = null;
        this.socket = await this.findSocket().catch((err: unknown) => {
          diag('member-request-failed', { message: err instanceof Error ? err.message : String(err) });
          return null;
        });
      });
    });
  }

  /** Discord refused a search for now: none goes before its retry_after (seconds). */
  private limited(r: { opcode?: number; retry_after?: number }): void {
    if (r.opcode !== REQUEST_GUILD_MEMBERS_OP || !(Number(r.retry_after) > 0)) return;
    this.limitedUntil = Math.max(this.limitedUntil, Date.now() + Number(r.retry_after) * MS_PER_S);
    diag('member-request-rate-limited', { retryAfterS: r.retry_after });
  }

  private forget(): void {
    this.sentQueries.clear();
  }

  /** When the next search may go: after any RATE_LIMITED wait, and once the window has room. */
  private nextAt(): number {
    const now = Date.now();
    while (this.sentAt.length && this.sentAt[0]! <= now - GATEWAY_SEND_WINDOW_MS) this.sentAt.shift();
    const roomAt = this.sentAt.length < this.perWindow ? 0 : this.sentAt[this.sentAt.length - this.perWindow]! + GATEWAY_SEND_WINDOW_MS;
    return Math.max(this.limitedUntil, roomAt);
  }

  /** False when no open gateway socket was found; the archive's members are then all there is. */
  request(guildId: string, query: string): Promise<boolean> {
    const mine = ++this.asked;
    this.newest.set(guildId, mine);
    return this.serial(async () => {
      const wait = this.nextAt() - Date.now();
      if (wait > 0) await sleep(wait);
      // Replaced while waiting (the owner typed on): the newer search asks for what is wanted now.
      if (this.newest.get(guildId) !== mine) return true;
      return this.ask(guildId, query);
    });
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
    if (!q || this.sentQueries.has(key)) return true;
    const frame = JSON.stringify({ op: REQUEST_GUILD_MEMBERS_OP, d: { guild_id: [guildId], query: q, limit: MEMBER_REQUEST_LIMIT, presences: true } });
    // Ours, not the client's: its shape is checked against the client's, not learned (clientShapes.ts).
    this.tap.own(frame);
    let sent = await this.send(frame);
    if (sent === 'closed') {
      // The cached socket closed (a reconnect): the frame wasn't sent, so look the socket up once more.
      this.socket = null;
      sent = await this.send(frame);
    }
    if (sent !== 'closed') this.sentAt.push(Date.now());
    if (sent === 'sent') this.sentQueries.add(key);
    else diag('member-request-not-sent', { reason: sent });
    return sent === 'sent';
  }

  /** closed means nothing sent; unknown means CDP failed and delivery is uncertain. Refreshes socket handles on the next keystroke rather than retrying. */
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
