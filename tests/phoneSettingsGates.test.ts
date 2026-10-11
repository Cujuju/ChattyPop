import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';

// The Node suite checks JSX contracts without mounting renderer modules.
interface Node {
  type: string;
  start?: number | null;
  end?: number | null;
  [key: string]: unknown;
}
interface Element {
  node: Node;
  ancestors: Node[];
  name: string;
  attrs: Record<string, string>;
  text: string;
}
const ROOT = join(import.meta.dirname, '../src/renderer/src/views/settings');

function elements(file: string): Element[] {
  const source = readFileSync(join(ROOT, file), 'utf8');
  const result: Element[] = [];
  const text = (node: Node): string => source.slice(node.start ?? 0, node.end ?? 0);
  const walk = (value: unknown, ancestors: Node[]): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return void value.forEach((child) => walk(child, ancestors));
    const node = value as Node;
    if (typeof node.type !== 'string') return;
    if (node.type === 'JSXElement') {
      const opening = node['openingElement'] as Node;
      const attrs: Record<string, string> = {};
      for (const attr of opening['attributes'] as Node[]) {
        if (attr.type === 'JSXAttribute') attrs[text(attr['name'] as Node)] = attr['value'] ? text(attr['value'] as Node) : '';
      }
      result.push({ node, ancestors, name: text(opening['name'] as Node), attrs, text: text(node) });
    }
    Object.values(node).forEach((child) => walk(child, [...ancestors, node]));
  };
  walk(parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] }), []);
  return result;
}

/** Where a Settings window runs: the app's own (on the server's screen), a remote desktop, or the phone. */
type Surface = 'desktop' | 'remote' | 'phone';
/** The surface flags Settings gates on (state/ui.ts), as each surface has them. */
const FLAGS: Record<string, (s: Surface) => boolean> = {
  inCompanion: (s) => s === 'phone',
  onServerScreen: (s) => s === 'desktop',
};

/** A Show condition on `surface`: its surface flags evaluated, anything else (a signal) taken as true. */
function holds(when: string, surface: Surface): boolean {
  return when.replace(/^\{|\}$/g, '').split('&&').every((part) => {
    const term = part.trim();
    const negated = term.startsWith('!');
    const flag = FLAGS[negated ? term.slice(1) : term];
    return flag ? flag(surface) !== negated : true;
  });
}

/** Whether `element` shows on `surface`: every Show around it holds there (or fails, for its fallback). */
function shownOn(element: Element, all: Element[], surface: Surface): boolean {
  return element.ancestors.every((ancestor, i) => {
    const show = all.find((candidate) => candidate.node === ancestor && candidate.name === 'Show');
    if (!show) return true;
    const inFallback = element.ancestors.slice(i + 1).some((node) =>
      node.type === 'JSXAttribute' && (node['name'] as { name?: string })?.name === 'fallback');
    return holds(show.attrs['when'] ?? '', surface) !== inFallback;
  });
}

/** Whether `element` shows on the phone only (`companion`) or on the desktop only. */
const gate = (element: Element, all: Element[], companion: boolean): boolean =>
  companion ? shownOn(element, all, 'phone') && !shownOn(element, all, 'desktop') : shownOn(element, all, 'desktop') && !shownOn(element, all, 'phone');

const NOTES = [
  ['StorageLocation.tsx', 'Move the archive or delete its previous copy on your PC.'],
  ['OpenRouterKeys.tsx', 'Sign in with OpenRouter on'],
  ['PluginsSection.tsx', 'Open the plugins folder on'],
  ['MarketplacesSection.tsx', 'Use a plugin folder or .tar.gz on'],
  ['rules/kinds/actions.tsx', 'Choose a file on your PC, or enter its PC path here.'],
  ['ShortcutKeys.tsx', "Change shortcuts with your PC's keyboard."],
  ['AppearanceSection.tsx', "This phone's theme and layout: Settings → Look"],
] as const;

describe('phone Settings controls', () => {
  it.each(NOTES)('%s shows its PC/Look note only on the phone', (file, note) => {
    const all = elements(file);
    const notes = all.filter((element) => element.name === 'Note' && element.text.includes(note));
    expect(notes).toHaveLength(1);
    expect(gate(notes[0]!, all, true)).toBe(true);
    expect(gate(notes[0]!, all, false)).toBe(false);
  });

  it.each([
    ['StorageLocation.tsx', 'moveArchive'],
    ['StorageLocation.tsx', 'deletePreviousArchive'],
    ['OpenRouterKeys.tsx', 'api.openRouter.signIn'],
    ['PluginsSection.tsx', 'openPluginsFolder'],
    ['rules/kinds/actions.tsx', 'pickFile'],
  ])('%s gates the %s button to the desktop', (file, call) => {
    const all = elements(file);
    const buttons = all.filter((element) => element.name === 'button' && element.attrs['onClick']?.includes(call));
    expect(buttons).toHaveLength(1);
    expect(gate(buttons[0]!, all, false)).toBe(true);
    expect(gate(buttons[0]!, all, true)).toBe(false);
  });

  it.each([
    ['StorageLocation.tsx', 'moveArchive', false],
    ['StorageLocation.tsx', 'deletePreviousArchive', true],
    ['OpenRouterKeys.tsx', 'api.openRouter.signIn', false],
    ['PluginsSection.tsx', 'openPluginsFolder', false],
    ['rules/kinds/actions.tsx', 'pickFile', false],
  ])("%s on a remote desktop: the %s button shows only when it doesn't need the server's screen (%s)", (file, call, shown) => {
    const all = elements(file);
    const button = all.find((element) => element.name === 'button' && element.attrs['onClick']?.includes(call))!;
    expect(shownOn(button, all, 'remote')).toBe(shown);
  });

  it.each(['StorageLocation.tsx', 'OpenRouterKeys.tsx', 'PluginsSection.tsx', 'MarketplacesSection.tsx', 'rules/kinds/actions.tsx'])(
    '%s tells a remote desktop to use the server for what it hides',
    (file) => {
      const all = elements(file);
      const notes = all.filter((element) => element.name === 'Note' && element.text.includes('the server'));
      expect(notes).toHaveLength(1);
      expect(shownOn(notes[0]!, all, 'remote')).toBe(true);
      expect(shownOn(notes[0]!, all, 'desktop')).toBe(false);
    },
  );

  it.each([
    ['OpenRouterKeys.tsx', 'id', '"openrouter-key"'],
    ['MarketplacesSection.tsx', 'id', '"marketplace-local-path"'],
    ['rules/kinds/actions.tsx', 'id', "{id('path')}"],
    ['AppearanceSection.tsx', 'name', 'CustomThemeCard'],
    ['AppearanceSection.tsx', 'name', 'PanelColorsCard'],
    ['ArchiveSection.tsx', 'name', 'EncryptionControl'],
  ])('%s retains the working %s %s control on both surfaces', (file, attr, value) => {
    const all = elements(file);
    const controls = all.filter((element) => attr === 'name' ? element.name === value : element.name === 'input' && element.attrs[attr] === value);
    expect(controls).toHaveLength(1);
    expect(gate(controls[0]!, all, false)).toBe(false);
    expect(gate(controls[0]!, all, true)).toBe(false);
  });

  it('keeps phone bindings read-only without keyboard capture or reset handlers', () => {
    const all = elements('ShortcutKeys.tsx');
    const phoneInputs = all.filter((element) => element.name === 'input' && gate(element, all, true));
    expect(phoneInputs).toHaveLength(2);
    for (const input of phoneInputs) {
      expect(input.attrs).toHaveProperty('readOnly');
      expect(input.attrs).toHaveProperty('value');
      expect(Object.keys(input.attrs).filter((attr) => attr.startsWith('on'))).toEqual([]);
    }
    const captureOrReset = all.filter((element) => ['input', 'button', 'SettingsButton'].includes(element.name)
      && (element.attrs['onKeyDown'] || element.attrs['onClick']));
    expect(captureOrReset).toHaveLength(5);
    for (const control of captureOrReset) expect(gate(control, all, false)).toBe(true);
  });

  it('gates the theme and density choices while keeping their desktop handlers', () => {
    const all = elements('AppearanceSection.tsx');
    const choices = all.filter((element) => element.attrs['name'] === '"theme"' || element.attrs['id'] === '"archive-density"');
    expect(choices).toHaveLength(2);
    for (const choice of choices) {
      expect(choice.attrs).toHaveProperty('onChange');
      expect(gate(choice, all, false)).toBe(true);
      expect(gate(choice, all, true)).toBe(false);
    }
  });
});
