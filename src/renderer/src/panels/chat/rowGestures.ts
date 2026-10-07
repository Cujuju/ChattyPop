// A message row's touch gestures, as this device's chat settings choose them: the right-to-left swipe and the double tap.
import type { SwipeAction } from '@shared/chatSettings';
import type { ArchiveMessage } from '@shared/contract';
import { deviceChatSettings } from '@/state/chatSettings';
import { postingUnlocked } from '@/state/posting';
import { canReact, react, reactedWith } from '@/state/reactions';
import { canReply, startReply } from '@/state/reply';
import { allTouch, doubleTapToAct, swipeLeftToAct, type TouchHandlers } from '@/ui/touch';

interface SwipeRun {
  run(m: ArchiveMessage): void;
  /** Whether a swipe on `m` arms at all. */
  allowed(m: ArchiveMessage): boolean;
}

/** What each swipe action does. Replying needs posting unlocked; 'none' never arms. */
export const SWIPE_RUNS: Record<SwipeAction, SwipeRun> = {
  reply: { run: startReply, allowed: (m) => postingUnlocked() && canReply(m) },
  none: { run: () => undefined, allowed: () => false },
};

/** Adds the double-tap emoji, never removes it: whether Discord's double tap takes a reaction back is unverified. */
export function doubleTapReact(m: ArchiveMessage): void {
  const emoji = deviceChatSettings().doubleTapEmoji;
  if (!reactedWith(m, emoji)) react(m, emoji, true);
}

/** The row's touch handlers. Settings are read per gesture, so a change applies to the next touch. */
export function rowGestures(m: () => ArchiveMessage): TouchHandlers {
  const swipe = (): SwipeRun => SWIPE_RUNS[deviceChatSettings().swipeAction];
  return allTouch(
    swipeLeftToAct(
      () => swipe().run(m()),
      () => swipe().allowed(m()),
    ),
    // Reactions are exempt from the posting lock (shared/posting.ts), as in the picker.
    doubleTapToAct(
      () => doubleTapReact(m()),
      () => deviceChatSettings().doubleTapReact && canReact(m()),
    ),
  );
}
