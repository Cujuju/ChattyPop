// Plugin labels as local pills in Discord; an attribute and ::after leave Discord's own markup intact.
import type { WebContents } from 'electron';
import { errorMessage } from '@shared/errors';

/** The attribute carrying a message's labels; its ::after draws the pill. */
const ATTR = 'data-chattypop-labels';
/** Joins several labels in one pill. */
const SEPARATOR = ' · ';
/** Accent for live message labels; the embedded page cannot read renderer theme tokens. */
const LABEL_ACCENT = '#e58fd0';

/**
 * Pill styling in Discord's own variables and em units, so it follows the client's theme and font size. The ~20%
 * accent tint matches the renderer's --cp-section-tile-mix on chips.
 */
export const LIVE_LABELS_CSS = `
[id^="message-content-"][${ATTR}]::after {
  content: attr(${ATTR});
  display: inline-block;
  margin-left: 0.5em;
  padding: 0 0.45em;
  border-radius: 0.3em;
  background: color-mix(in srgb, ${LABEL_ACCENT} 20%, transparent);
  color: ${LABEL_ACCENT};
  font-size: 0.7em;
  font-weight: 600;
  letter-spacing: 0.02em;
  line-height: 1.6;
  text-transform: uppercase;
  vertical-align: middle;
}`;

/**
 * Runs in the page: keeps the current channel's label map and marks each message's text element, now and whenever
 * Discord adds or re-renders message rows. Idempotent; `set` replaces the map.
 */
const INSTALL = `(() => {
  if (window.__chattypopLabels) return;
  let labels = {};
  const mark = (el) => {
    const id = el.id.slice('message-content-'.length);
    const text = labels[id];
    if (text) {
      if (el.getAttribute('${ATTR}') !== text) el.setAttribute('${ATTR}', text);
    } else if (el.hasAttribute('${ATTR}')) {
      el.removeAttribute('${ATTR}');
    }
  };
  const markAll = (root) => root.querySelectorAll('[id^="message-content-"]').forEach(mark);
  new MutationObserver((changes) => {
    for (const c of changes) for (const n of c.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.id && n.id.startsWith('message-content-')) mark(n);
      else markAll(n);
    }
  }).observe(document.body, {
    childList: true,
    subtree: true,
  });
  window.__chattypopLabels = {
    set(next) {
      labels = next;
      markAll(document);
    },
  };
})();`;

/** Keeps the live client's pills in step with the channel it shows and with label changes. */
export class LiveLabels {
  private channelId: string | null = null;
  /** Serializes pushes so a slow one can't overwrite a newer map. */
  private pushing: Promise<void> = Promise.resolve();

  constructor(
    private readonly page: () => WebContents | undefined,
    private readonly chipsFor: (channelId: string) => Promise<Record<string, string[]>>,
    private readonly onError: (message: string) => void,
  ) {}

  /** A new document (load or reload): style it, then mark what it shows. */
  documentReady(): void {
    const wc = this.page();
    if (!wc || wc.isDestroyed()) return;
    wc.insertCSS(LIVE_LABELS_CSS).catch((err: unknown) => this.onError(errorMessage(err)));
    this.refresh();
  }

  showChannel(channelId: string): void {
    this.channelId = channelId;
    this.refresh();
  }

  /** Labels changed somewhere: re-read the shown channel's pills. */
  changed(): void {
    this.refresh();
  }

  private refresh(): void {
    const channelId = this.channelId;
    if (!channelId) return;
    this.pushing = this.pushing
      .then(async () => {
        const wc = this.page();
        if (!wc || wc.isDestroyed() || channelId !== this.channelId) return;
        const chips = await this.chipsFor(channelId);
        if (channelId !== this.channelId || wc !== this.page() || wc.isDestroyed()) return;
        const labels = Object.fromEntries(Object.entries(chips).map(([id, cs]) => [id, cs.join(SEPARATOR)]));
        await wc.executeJavaScript(`${INSTALL}\nwindow.__chattypopLabels.set(${JSON.stringify(labels)});`);
      })
      .catch((err: unknown) => this.onError(errorMessage(err)));
  }
}
