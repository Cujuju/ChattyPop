// CSS declarations and the look / structure split for plugin styles (docs/plugin-architecture.md §14): the style test
// checks every plugin folder with it, and the installed-plugin build checks the plugin it builds.

/** One declaration and where it sits: its selector (with any enclosing at-rules) and file. */
export interface Declaration {
  file: string;
  selector: string;
  property: string;
  value: string;
}

/** Every declaration in `css`, nested rules and at-rules included; comments and top-level statements (@import) skipped. */
export function declarations(file: string, css: string): Declaration[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Declaration[] = [];
  const preludes: string[] = [];
  let buffer = '';
  let parens = 0;
  let quote: string | null = null;
  const flush = (): void => {
    const statement = buffer.trim();
    buffer = '';
    const colon = statement.indexOf(':');
    if (!preludes.length || colon < 0) return;
    out.push({ file, selector: preludes.join(' » '), property: statement.slice(0, colon).trim().toLowerCase(), value: statement.slice(colon + 1).trim() });
  };
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      buffer += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      buffer += ch;
    } else if (ch === '(') {
      parens++;
      buffer += ch;
    } else if (ch === ')') {
      parens--;
      buffer += ch;
    } else if (ch === ';' && parens === 0) {
      flush();
    } else if (ch === '{' && parens === 0) {
      preludes.push(buffer.trim());
      buffer = '';
    } else if (ch === '}' && parens === 0) {
      flush();
      preludes.pop();
    } else buffer += ch;
  }
  return out;
}

const matches = (property: string, names: readonly string[], prefixes: readonly string[]): boolean =>
  names.includes(property) || prefixes.some((p) => property.startsWith(p));

/** Layout and box geometry: what a plugin's own CSS may set. Text flow sits here: it decides where lines break, not how glyphs look. */
export const STRUCTURE_PROPERTIES = [
  'display', 'position', 'inset', 'top', 'right', 'bottom', 'left', 'z-index', 'isolation', 'float', 'clear',
  'flex', 'order', 'grid', 'gap', 'row-gap', 'column-gap',
  'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height', 'inline-size', 'block-size', 'aspect-ratio', 'box-sizing',
  // A field's box: sized to its content, and whether the owner may drag its size.
  'field-sizing', 'resize',
  // Multi-column flow: how many columns, and which boxes a column break may not split.
  'columns', 'column-count', 'column-width', 'break-inside',
  'overflow', 'overflow-x', 'overflow-y', 'object-fit', 'object-position',
  'text-align', 'white-space', 'text-overflow', 'word-break', 'overflow-wrap', 'hyphens', 'text-wrap', 'vertical-align',
  'line-clamp', '-webkit-line-clamp', '-webkit-box-orient',
  'visibility', 'pointer-events', 'touch-action', 'user-select', '-webkit-user-select',
  // Borderline: generated boxes and numbering are content, not their paint; list-style: none removes marker boxes, as display would.
  'content', 'counter-reset', 'counter-increment', 'list-style',
  'container', 'container-type', 'container-name', 'contain', 'scrollbar-gutter',
  // Borderline: translate moves a box (a drawer's closed position, a pull's offset); rotate and scale are effects (look).
  'translate', 'transform',
] as const;
export const STRUCTURE_PREFIXES = ['flex-', 'grid-', 'align-', 'justify-', 'place-', 'inset-', 'margin', 'padding', 'scroll-', 'overscroll-'] as const;

/** How things look: what only the theme sets. */
export const LOOK_PROPERTIES = [
  'color', 'background', 'box-shadow', 'opacity', 'filter', 'backdrop-filter', '-webkit-backdrop-filter', 'cursor', 'appearance', 'accent-color', 'caret-color',
  'line-height', 'letter-spacing', 'text-transform', 'text-shadow', 'mix-blend-mode', 'scrollbar-color', 'scrollbar-width', 'color-scheme',
  'fill', 'rotate', 'scale',
] as const;
export const LOOK_PREFIXES = ['background-', 'border', 'outline', 'font', 'text-decoration', 'transition', 'animation', 'stroke', 'mask'] as const;

/** A `transform` counts as structure only when it translates (or is none); anything else is an effect. */
const TRANSLATE_ONLY = /^none$|^(?:translate[XY]?\((?:[^()]|\([^()]*\))*\)\s*)+$/;

export const isCustomProperty = (property: string): boolean => property.startsWith('--');

export const isStructure = (d: Declaration): boolean =>
  d.property === 'transform' ? TRANSLATE_ONLY.test(d.value) : matches(d.property, STRUCTURE_PROPERTIES, STRUCTURE_PREFIXES);

export const isLook = (d: Declaration): boolean =>
  d.property === 'transform' ? !TRANSLATE_ONLY.test(d.value) : matches(d.property, LOOK_PROPERTIES, LOOK_PREFIXES);

/** Functions a structural value may use: arithmetic, track sizing, safe-area insets, counters and translation. */
export const STRUCTURE_FUNCTIONS = ['var', 'calc', 'min', 'max', 'clamp', 'minmax', 'repeat', 'fit-content', 'env', 'counter', 'translate', 'translatex', 'translatey'] as const;
/** Units that are proportions of the box, not sizes: percentages and grid fractions. Unitless numbers (flex factors, spans, multipliers) are counts. */
export const PROPORTION_UNITS = ['%', 'fr'] as const;
/** Properties whose strings are names, not text: grid areas, and generated content. */
export const STRING_PROPERTIES = ['grid-template-areas', 'content'] as const;

const TOKEN = /\s+|--[\w-]+|#[\w]+|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[+-]?(?:\d+\.?\d*|\.\d+)(?:[a-z%]+)?|-?[a-z_][\w-]*\(?|[(),/*+-]|./gi;

/** Why `d`'s value isn't tokens, keywords, zero, counts and proportions (a length, time, angle, colour or text literal), or null. */
export function literalIn(d: Declaration): string | null {
  for (const [token] of d.value.matchAll(TOKEN)) {
    if (/^\s+$|^--|^[(),/*+-]$/.test(token)) continue;
    if (token.endsWith('(')) {
      if (!(STRUCTURE_FUNCTIONS as readonly string[]).includes(token.slice(0, -1).toLowerCase())) return `function ${token})`;
      continue;
    }
    const number = /^[+-]?(?:\d+\.?\d*|\.\d+)([a-z%]*)$/i.exec(token);
    if (number) {
      const unit = number[1]!.toLowerCase();
      if (unit && !(PROPORTION_UNITS as readonly string[]).includes(unit) && Number.parseFloat(token) !== 0) return `literal ${token}`;
      continue;
    }
    if (/^["']/.test(token)) {
      if (token.length > 2 && !(STRING_PROPERTIES as readonly string[]).includes(d.property)) return `string ${token}`;
      continue;
    }
    if (/^#/.test(token)) return `colour ${token}`;
    if (!/^-?[a-z_][\w-]*$/i.test(token)) return `token ${token}`;
  }
  return null;
}

/** Custom properties any look declaration reads, directly or through other custom properties' values. */
export function lookCustomProperties(all: readonly Declaration[]): Set<string> {
  const reads = (value: string): string[] => [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]!);
  const look = new Set(all.filter(isLook).flatMap((d) => reads(d.value)));
  const defined = all.filter((d) => isCustomProperty(d.property));
  for (let grew = true; grew; ) {
    grew = false;
    for (const d of defined) {
      if (!look.has(d.property)) continue;
      for (const v of reads(d.value)) {
        if (look.has(v)) continue;
        look.add(v);
        grew = true;
      }
    }
  }
  return look;
}

/** What's wrong with a plugin's declaration, or null: plugins set structure with tokens, and never a token the look reads. */
export function pluginViolation(d: Declaration, lookTokens: ReadonlySet<string>): string | null {
  if (isCustomProperty(d.property)) {
    if (lookTokens.has(d.property)) return 'sets a custom property a look declaration reads';
  } else if (!isStructure(d)) {
    return isLook(d) ? 'look property (the theme owns it)' : 'property not classified as structure';
  }
  return literalIn(d);
}

/** `file selector { property: value }`, for messages. */
export const where = (d: Declaration): string => `${d.file} ${d.selector} { ${d.property}: ${d.value} }`;
