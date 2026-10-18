// Which channels show their threads in channel lists (the Archive's, its rail, Attachments'); the rest fold them away.
import { stringsOr } from '@shared/normalize';
import { SETTINGS_KEYS } from '@shared/settings';
import { createSetting } from '@plugin-sdk/renderer/settings';
import { threadsOf } from './directory';

const [openChannels, setOpenChannels] = createSetting<string[]>(SETTINGS_KEYS.threadsOpen, [], (v) => [...new Set(stringsOr([])(v))]);

/** Whether `channelId`'s threads show under it; folded by default. */
export const threadsShown = (channelId: string): boolean => openChannels().includes(channelId);

export const showThreads = (channelId: string, shown: boolean): void => {
  if (threadsShown(channelId) === shown) return;
  void setOpenChannels(shown ? [...openChannels(), channelId] : openChannels().filter((id) => id !== channelId));
};

/** Marks a row's FoldChevron, so a click on it folds rather than opens. */
export const FOLD_CHEVRON_ATTR = 'data-fold-chevron';

/**
 * A channel row's fold gestures: a click on its chevron, Alt+click or a double-click toggles; Right and Left unfold and
 * fold. True when `e` was one; the row then does nothing else with it. Call only for a channel with threads.
 */
export function foldGesture(e: MouseEvent | KeyboardEvent, channelId: string): boolean {
  if (e.ctrlKey || e.metaKey || e.shiftKey) return false;
  if ('key' in e) {
    if (e.altKey || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return false;
    showThreads(channelId, e.key === 'ArrowRight');
  } else {
    const onChevron = e.target instanceof Element && e.target.closest(`[${FOLD_CHEVRON_ATTR}]`) !== null;
    // A double-click's own clicks open the row, then it folds; on the chevron, those clicks already did.
    if (e.type === 'dblclick') {
      if (!onChevron) showThreads(channelId, !threadsShown(channelId));
    } else if (onChevron || e.altKey) showThreads(channelId, !threadsShown(channelId));
    else return false;
  }
  e.preventDefault();
  return true;
}

/** What `channelId`'s archived threads hold that the owner hasn't seen, for its folded row. */
export const unseenInThreads = (channelId: string): { newCount: number; mentionCount: number } =>
  threadsOf(channelId).reduce((sum, t) => ({ newCount: sum.newCount + t.newCount, mentionCount: sum.mentionCount + t.mentionCount }), { newCount: 0, mentionCount: 0 });
