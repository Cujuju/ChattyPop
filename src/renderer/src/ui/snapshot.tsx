// A view as a self-contained HTML page that looks as the app draws it: the app's own styles and theme, fonts embedded, nothing to load.
import type { JSX } from 'solid-js';
import { render } from 'solid-js/web';
import SNAPSHOT_CSS from '@/theme/snapshot.css?raw';
import styles from './Snapshot.module.css';

/** Frames to wait after rendering, so resources a view reads (names, colours) settle before it is copied. */
const SETTLE_FRAMES = 2;

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const nextFrame = (): Promise<void> => new Promise((done) => requestAnimationFrame(() => done()));

/** Font files as data URLs, read once each. */
const fontData = new Map<string, Promise<string>>();
function dataUrl(url: string): Promise<string> {
  let read = fontData.get(url);
  if (!read) {
    read = fetch(url)
      .then((r) => r.blob())
      .then((blob) => new Promise<string>((done, fail) => {
        const reader = new FileReader();
        reader.onload = () => done(String(reader.result));
        reader.onerror = () => fail(reader.error);
        reader.readAsDataURL(blob);
      }));
    fontData.set(url, read);
  }
  return read;
}

const URL_IN_CSS = /url\((['"]?)([^'")]+)\1\)/g;

/** Every style rule the page has, font files embedded; a sheet the page may not read is skipped. */
async function pageCss(): Promise<string> {
  const rules: Promise<string>[] = [];
  for (const sheet of [...document.styleSheets]) {
    let list: CSSRuleList;
    try {
      list = sheet.cssRules;
    } catch {
      continue;
    }
    const base = sheet.href ?? location.href;
    for (const rule of [...list]) {
      if (!(rule instanceof CSSFontFaceRule)) {
        rules.push(Promise.resolve(rule.cssText));
        continue;
      }
      const urls = [...rule.cssText.matchAll(URL_IN_CSS)].map((m) => m[2]!).filter((u) => !u.startsWith('data:'));
      rules.push(
        Promise.all(urls.map(async (u) => [u, await dataUrl(new URL(u, base).href).catch(() => u)] as const)).then((pairs) =>
          pairs.reduce((css, [u, data]) => css.split(u).join(data), rule.cssText),
        ),
      );
    }
  }
  // A style element's text ends at "</": keep any in the rules out of the markup.
  return (await Promise.all(rules)).join('\n').replace(/<\//g, '<\\/');
}

/**
 * `view` drawn `width` CSS px wide (the page's margin included) and copied as a page titled `title`.
 * Interactive parts copy as they look; the page runs no script.
 */
export async function snapshotPage(view: () => JSX.Element, opts: { title: string; width: number }): Promise<string> {
  const stage = document.createElement('div');
  stage.className = styles.stage!;
  stage.setAttribute('aria-hidden', 'true');
  document.body.append(stage);
  // The stage lays the view out at the page's width less its margin, as the snapshot's body will.
  const margin = parseFloat(getComputedStyle(stage).getPropertyValue('--cp-snapshot-margin')) || 0;
  stage.style.width = `${Math.max(0, opts.width - 2 * margin)}px`;
  const dispose = render(view, stage);
  try {
    for (let i = 0; i < SETTLE_FRAMES; i++) await nextFrame();
    await document.fonts.ready;
    const root = document.documentElement;
    const attrs = [...root.attributes].map((a) => ` ${a.name}="${esc(a.value)}"`).join('');
    const css = await pageCss();
    return `<!doctype html>\n<html${attrs}><head><meta charset="utf-8"><meta name="viewport" content="width=${opts.width}"><title>${esc(opts.title)}</title>
<style>${css}</style><style>${SNAPSHOT_CSS}</style></head><body>${stage.innerHTML}</body></html>\n`;
  } finally {
    dispose();
    stage.remove();
  }
}
