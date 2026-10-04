import type { WebContents } from 'electron';
import { errorMessage } from '@shared/errors';
import { diag } from '../diagnostics';

/** Page global the watcher reports through: a CDP binding, so the page needs no preload. */
const MODAL_BINDING = '__chattyPopModal';
const OPEN = '1';
const CLOSED = '0';

/**
 * Runs in the Discord page: reports whether a modal (image viewer, profile, confirm) is open. Discord marks each with
 * the standard aria-modal; checks coalesce per task, as the message list mutates constantly.
 */
const WATCH_SCRIPT = `(() => {
  if (window.${MODAL_BINDING}Watching) return;
  window.${MODAL_BINDING}Watching = true;
  let open = false;
  let queued = false;
  const check = () => {
    queued = false;
    const now = document.querySelector('[aria-modal="true"]') !== null;
    if (now !== open) ${MODAL_BINDING}((open = now) ? '${OPEN}' : '${CLOSED}');
  };
  new MutationObserver(() => {
    if (!queued) queueMicrotask(check);
    queued = true;
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-modal'] });
  check();
})()`;

type WatchedPage = Pick<WebContents, 'debugger' | 'executeJavaScript' | 'on'>;

/**
 * Calls `onChange` when a Discord modal opens or closes in the page, and with false for each new document. Uses the
 * debugger the gateway tap attached.
 */
export function watchModals(wc: WatchedPage, onChange: (open: boolean) => void): void {
  wc.debugger.sendCommand('Runtime.addBinding', { name: MODAL_BINDING }).catch((err: unknown) => diag('discord-modal-watch-failed', { message: errorMessage(err) }));
  wc.debugger.on('message', (_e, method, params: { name?: string; payload?: string }) => {
    if (method !== 'Runtime.bindingCalled' || params.name !== MODAL_BINDING) return;
    if (params.payload === OPEN || params.payload === CLOSED) onChange(params.payload === OPEN);
  });
  wc.on('dom-ready', () => {
    onChange(false);
    wc.executeJavaScript(WATCH_SCRIPT).catch((err: unknown) => diag('discord-modal-watch-failed', { message: errorMessage(err) }));
  });
}
