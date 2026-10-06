// Posting requires an enabled unlocking plugin. Host and plugin writes check locks on call and immediately before every attempt.
import { BUNDLED_PLUGINS } from '@shared/bundledPlugins';
import type { PluginDescriptor } from '@shared/bundledTypes';
import type { PluginInfo } from '@shared/plugins';
import { isPostingCall, PostingLocked, postingUnlockedIn } from '@shared/posting';
import type { DiscordClient, DiscordQuery, RequestOptions, WriteOptions } from '../discord/client';

export interface PostingGate {
  /** Whether posting is unlocked, from core's plugin list read now: a post right after a switch sees it, not a lagging snapshot. */
  unlocked(): Promise<boolean>;
}

/** The gate over `descriptors` (this build's and the installed ones), each on or off as core's list `load` says. */
export const postingGate = (load: () => Promise<readonly PluginInfo[]>, descriptors: readonly PluginDescriptor[] = BUNDLED_PLUGINS): PostingGate => ({
  unlocked: async () => postingUnlockedIn(descriptors, await load()),
});

/** Throws PostingLocked unless `gate` is unlocked now. */
async function assertUnlocked(gate: PostingGate): Promise<void> {
  if (!(await gate.unlocked())) throw new PostingLocked();
}

type Calls = Record<string, (...args: never[]) => Promise<unknown>>;

/** `calls` with each posting call (isPostingCall) refusing while `gate` is locked; the others unchanged. */
export function gatePosting<T extends Calls>(gate: PostingGate, calls: T): T {
  const gated: Calls = { ...calls };
  for (const [name, call] of Object.entries(calls)) {
    if (!isPostingCall(name)) continue;
    gated[name] = async (...args) => {
      await assertUnlocked(gate);
      return call(...args);
    };
  }
  return gated as T;
}

/** The owner's own reaction (PUT adds, DELETE takes back); its emoji part is never a dot segment or a separator. */
const OWN_REACTION_PATH = /^channels\/\d+\/messages\/\d+\/reactions\/(?!\.\.?\/)[^/?#\\]+\/@me$/;
/** A read ack. */
const ACK_PATH = /^channels\/\d+\/messages\/\d+\/ack$/;

/** Writes the lock exempts (owner's choice): the owner's own reactions, added or taken back, and read acks. */
export const exemptWrite = (method: 'post' | 'put' | 'delete', path: string): boolean =>
  method === 'post' ? ACK_PATH.test(path) : OWN_REACTION_PATH.test(path);

/** Checks posting locks at call time and after caller guards before every attempt, preventing queued/retried writes after relocking. Reads/exempt writes bypass checks. */
export function postingClient(client: DiscordClient, gate: PostingGate): DiscordClient {
  const guarded = (opts: WriteOptions | undefined): WriteOptions => ({
    ...opts,
    guard: async () => {
      await opts?.guard?.();
      await assertUnlocked(gate);
    },
  });
  /** Runs `send` with the lock checked now and per attempt, unless `exempt`. */
  const locked = async <T>(exempt: boolean, opts: WriteOptions | undefined, send: (opts: WriteOptions | undefined) => Promise<T>): Promise<T> => {
    if (exempt) return send(opts);
    await assertUnlocked(gate);
    return send(guarded(opts));
  };
  return {
    get: <T>(path: string, query?: DiscordQuery, opts?: RequestOptions) => client.get<T>(path, query, opts),
    post: <T>(path: string, json: unknown, opts?: WriteOptions) => locked(exemptWrite('post', path), opts, (o) => client.post<T>(path, json, o)),
    postOnce: <T>(path: string, json: unknown, opts?: WriteOptions) => locked(exemptWrite('post', path), opts, (o) => client.postOnce<T>(path, json, o)),
    put: (path: string, opts?: WriteOptions) => locked(exemptWrite('put', path), opts, (o) => client.put(path, o)),
    patch: <T>(path: string, json: unknown, opts?: WriteOptions) => locked(false, opts, (o) => client.patch<T>(path, json, o)),
    delete: (path: string, opts?: WriteOptions) => locked(exemptWrite('delete', path), opts, (o) => client.delete(path, o)),
    upload: async (url: string, bytes: Buffer) => {
      await assertUnlocked(gate);
      return client.upload(url, bytes);
    },
  };
}
