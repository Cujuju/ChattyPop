// Plugin labels as local pills in Discord: one injected stylesheet draws them with ::after; Discord's DOM is untouched.
import type { WebContents } from 'electron';
import { SNOWFLAKE_ID } from '@shared/discord';
import { errorMessage } from '@shared/errors';

/** Joins several labels in one pill. */
const SEPARATOR = ' · ';
/** Accent for live message labels; the embedded page cannot read renderer theme tokens. */
const LABEL_ACCENT = '#e58fd0';

/**
 * Pill styling in Discord's own variables and em units, so it follows the client's theme and font size. The ~20%
 * accent tint matches the renderer's --cp-section-tile-mix on chips.
 */
const PILL_STYLE = `
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
  vertical-align: middle;`;

/** `text` as a CSS string literal: quotes, backslashes and line breaks escaped. */
const cssString = (text: string): string => `"${text.replace(/["\\]/g, '\\$&').replace(/[\r\n\f]/g, '\\a ')}"`;

/** The stylesheet drawing `labels` (message id → pill text) after each message's text; empty when there are none. */
export function liveLabelsCss(labels: Readonly<Record<string, string>>): string {
  const entries = Object.entries(labels).filter(([id, text]) => SNOWFLAKE_ID.test(id) && text);
  if (!entries.length) return '';
  const pill = (id: string): string => `#message-content-${id}::after`;
  return [`${entries.map(([id]) => pill(id)).join(',\n')} {${PILL_STYLE}\n}`, ...entries.map(([id, text]) => `${pill(id)} { content: ${cssString(text)}; }`)].join('\n');
}

/** Keeps the live client's pills in step with the channel it shows and with label changes. */
export class LiveLabels {
  private channelId: string | null = null;
  /** The current document's label stylesheet; insertCSS is per document, so a new one starts without it. */
  private cssKey: string | undefined;
  /** Serializes pushes so a slow one can't overwrite a newer map. */
  private pushing: Promise<void> = Promise.resolve();

  constructor(
    private readonly page: () => WebContents | undefined,
    private readonly chipsFor: (channelId: string) => Promise<Record<string, string[]>>,
    private readonly onError: (message: string) => void,
  ) {}

  /** A new document (load or reload): draw what it shows. */
  documentReady(): void {
    this.cssKey = undefined;
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
        const css = liveLabelsCss(Object.fromEntries(Object.entries(chips).map(([id, cs]) => [id, cs.join(SEPARATOR)])));
        const previous = this.cssKey;
        this.cssKey = undefined;
        // A key from a document since replaced no longer exists; nothing to remove then.
        if (previous) await wc.removeInsertedCSS(previous).catch(() => undefined);
        if (css) this.cssKey = await wc.insertCSS(css);
      })
      .catch((err: unknown) => this.onError(errorMessage(err)));
  }
}
