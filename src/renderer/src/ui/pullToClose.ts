// The phone menu sheet's pull down to close.
import { listen } from './listen';
import { scrolledFromTop } from './scrollEdges';

/** A sheet pulled down past this share of its height closes on release, as iOS sheets do; short of it, it springs back. */
const SHEET_DISMISS_RATIO = 0.25;

/** Top-scrolled sheets follow downward pulls and close past SHEET_DISMISS_RATIO on release. data-pull disables spring transitions while dragging. */
export function pullToClose(sheet: HTMLDivElement, close: () => void): void {
  let startY: number | null = null;
  let pulled = 0;
  const settle = (): void => {
    startY = null;
    pulled = 0;
    delete sheet.dataset['pull'];
    sheet.style.removeProperty('translate');
  };
  listen(
    sheet,
    'touchstart',
    (e) => {
      const t = e.touches[0];
      startY = t && e.touches.length === 1 && scrolledFromTop(sheet) <= 0 ? t.clientY : null;
    },
    { passive: true },
  );
  // Not passive: a pull replaces the sheet's own overscroll.
  listen(
    sheet,
    'touchmove',
    (e) => {
      const t = e.touches[0];
      if (startY === null || !t) return;
      pulled = Math.max(0, t.clientY - startY);
      if (!pulled) return;
      e.preventDefault();
      sheet.dataset['pull'] = 'true';
      sheet.style.translate = `0 ${pulled}px`;
    },
    { passive: false },
  );
  listen(sheet, 'touchend', () => {
    const dismiss = pulled > sheet.offsetHeight * SHEET_DISMISS_RATIO;
    settle();
    if (dismiss) close();
  });
  listen(sheet, 'touchcancel', settle);
}
