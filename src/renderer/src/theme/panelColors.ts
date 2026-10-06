// Per-panel colors override --cp-section through data-panel-color, including shared sections. Adjusts contrast on all theme surfaces and supplies badge foregrounds.
import { hexToRgb, readableOn, type Rgb } from './color';

/** Generates one override rule per panel. html specificity beats section identity rules regardless of stylesheet order. */
const STYLE_ID = 'cp-panel-colors';
const SURFACE_TOKENS = [0, 1, 2, 3, 4, 5].map((n) => `--cp-surface-${n}`);
const TEXT_ON_SECTION = '--cp-text-on-accent';
/** Panel importances a theme may scope surfaces to (tide, spotlight); none is the plain panel. */
const IMPORTANCES = ['primary', 'secondary', 'reference'] as const;
const HEX = /^#[0-9a-f]{6}$/i;

/** Hex colours `tokens` resolve to on `el`; tokens that don't resolve to hex are skipped. */
function tokenColors(el: Element, tokens: string[]): Rgb[] {
  const css = getComputedStyle(el);
  return tokens.map((t) => css.getPropertyValue(t).trim()).filter((v) => HEX.test(v)).map(hexToRgb);
}

/** Every surface and badge text a panel can wear under `root`: probed plain and at each importance. */
function panelBackgrounds(root: HTMLElement): Rgb[] {
  const probes = [null, ...IMPORTANCES].map((importance) => {
    const probe = document.createElement('span');
    probe.hidden = true;
    if (importance) probe.dataset['importance'] = importance;
    root.append(probe);
    return probe;
  });
  const colors = probes.flatMap((probe) => tokenColors(probe, [...SURFACE_TOKENS, TEXT_ON_SECTION]));
  for (const probe of probes) probe.remove();
  return colors;
}

/** Applies panel colors against root’s theme and extra non-token backgrounds. Empty records clear overrides. */
export function wearPanelColors(root: HTMLElement, colors: Record<string, string>, extraBackgrounds: Rgb[]): void {
  let style = document.getElementById(STYLE_ID);
  const ids = Object.keys(colors);
  if (ids.length === 0) {
    style?.remove();
    return;
  }
  const on = [...panelBackgrounds(root), ...extraBackgrounds];
  const rules = ids.map((id) => `html [data-panel-color='${id}'] { --cp-section: ${on.length ? readableOn(colors[id]!, on) : colors[id]}; }`);
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.append(style);
  }
  style.textContent = rules.join('\n');
}

/** The colour section `section` wears in the theme on `root`, as identity.css resolves it: a probe carrying it, read back. */
export function themeSectionColor(root: HTMLElement, section: string): string {
  const probe = document.createElement('span');
  probe.hidden = true;
  probe.dataset['section'] = section;
  root.append(probe);
  const color = getComputedStyle(probe).getPropertyValue('--cp-section').trim().toLowerCase();
  probe.remove();
  return color;
}
