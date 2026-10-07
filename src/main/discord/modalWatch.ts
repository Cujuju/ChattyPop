import type { WebContents } from 'electron';
import { errorMessage } from '@shared/errors';
import { diag } from '../diagnostics';
import type { PageWorld } from './pageWorld';

/** CDP's answer when the document an awaited script ran in is replaced: that document's watch is over. */
const NAVIGATED = /navigated or closed|context was destroyed/i;

/** Resolves once the page's aria-modal state differs from `open`, with the new state. Leaves nothing in the page. */
const waitChange = (open: boolean): string => `new Promise((resolve) => {
  const now = () => document.querySelector('[aria-modal="true"]') !== null;
  if (now() !== ${open}) return resolve(${!open});
  const o = new MutationObserver(() => {
    if (now() === ${open}) return;
    o.disconnect();
    resolve(${!open});
  });
  o.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-modal'] });
})`;

/** Calls `onChange` when a Discord modal opens or closes in the page, and with false for each new document. */
export function watchModals(page: Pick<WebContents, 'on'>, world: Pick<PageWorld, 'evaluate'>, onChange: (open: boolean) => void): void {
  let generation = 0;
  page.on('dom-ready', () => {
    const mine = ++generation;
    onChange(false);
    void (async () => {
      for (let open = false; ; ) {
        open = await world.evaluate<boolean>(waitChange(open));
        if (mine !== generation) return;
        onChange(open);
      }
    })().catch((err: unknown) => {
      if (mine === generation && !NAVIGATED.test(errorMessage(err))) diag('discord-modal-watch-failed', { message: errorMessage(err) });
    });
  });
}
