// Posting requires enabled unlocking plugins for host/plugin writes. Reads, reactions and acknowledgments are exempt.
import type { PluginDescriptor } from './bundledTypes';
import { pluginOn, type PluginInfo } from './plugins';
import type { RendererApi } from './rendererApi';

/** Discord calls refused while posting is locked: posts, edits, deletes, forwards, threads, interactions, DM management. */
export const POSTING_CALLS = [
  'send',
  'edit',
  'deleteMessage',
  'forward',
  'runCommand',
  'autocomplete',
  'useComponent',
  'submitModal',
  'createThread',
  'sendDirect',
  'startDm',
  'dmWith',
  'addToDm',
  'closeDm',
  'renameDm',
  'muteDm',
] as const satisfies readonly (keyof RendererApi['discord'])[];
export type PostingCall = (typeof POSTING_CALLS)[number];
const postingCalls = new Set<string>(POSTING_CALLS);
/** Whether Discord call `name` is one the lock refuses. */
export const isPostingCall = (name: string): name is PostingCall => postingCalls.has(name);

/** Whether descriptor `p` declares the posting unlock. */
export const unlocksPosting = (p: PluginDescriptor): boolean => p.unlocks?.posting === true;

/** Posting is unlocked iff a plugin among `descriptors` that is on in core's list `list` declares the unlock. */
export const postingUnlockedIn = (descriptors: readonly PluginDescriptor[], list: readonly PluginInfo[]): boolean =>
  descriptors.some((p) => unlocksPosting(p) && pluginOn(list, p.manifest.id));

/** PostingLocked's message: the one part of it every transport (IPC, the phone's HTTP) carries. */
const LOCKED_MESSAGE = 'Posting is off: it needs a plugin that turns it on.';

/** A posting call refused while no plugin that is on unlocks posting: nothing was sent. */
export class PostingLocked extends Error {
  override name = 'PostingLocked';
  constructor() {
    super(LOCKED_MESSAGE);
  }
}

/** Whether `err` is a PostingLocked, as thrown or as a transport rebuilt it (IPC prefixes the message). */
export const isPostingLocked = (err: unknown): boolean => err instanceof PostingLocked || (err instanceof Error && err.message.endsWith(LOCKED_MESSAGE));

/** `call`, with a PostingLocked a transport carried as a plain error restored to one. */
export const keepPostingLocked = <T>(call: Promise<T>): Promise<T> =>
  call.catch((err: unknown) => {
    throw isPostingLocked(err) ? new PostingLocked() : err;
  });
