import type { WebContents } from 'electron';

const DISCORD_ORIGIN = 'https://discord.com';

/**
 * The file of one @font-face family the Discord page declares (its Nitro display-name fonts), as an absolute URL on
 * discord.com; null when the page isn't loaded or hasn't declared it. File names change with Discord's deploys.
 */
export async function discordFontUrl(wc: WebContents | undefined, family: string): Promise<string | null> {
  if (!wc || wc.isDestroyed()) return null;
  // At startup the Archive asks before the page has its stylesheets: wait for the load rather than answer "none".
  if (wc.isLoading()) await new Promise<void>((resolve) => wc.once('did-stop-loading', () => resolve()));
  // String.raw: the regex's escapes must reach the page intact.
  const script = String.raw`(() => {
    const want = ${JSON.stringify(family)};
    const walk = (rules, base) => {
      for (const r of rules) {
        if (r instanceof CSSFontFaceRule && r.style.getPropertyValue('font-family').replace(/["']/g, '').trim() === want) {
          const m = /url\(["']?([^"')]+)["']?\)/.exec(r.style.getPropertyValue('src'));
          if (m) return new URL(m[1], base).href;
        } else if (r.cssRules) {
          const found = walk(r.cssRules, base);
          if (found) return found;
        }
      }
      return null;
    };
    for (const s of document.styleSheets) {
      let rules;
      try { rules = s.cssRules; } catch { continue; }
      const found = walk(rules, s.href || location.href);
      if (found) return found;
    }
    return null;
  })()`;
  const url = (await wc.executeJavaScript(script).catch(() => null)) as string | null;
  return url && new URL(url).origin === DISCORD_ORIGIN ? url : null;
}
