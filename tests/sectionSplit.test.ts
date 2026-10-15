import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { build, type Plugin } from 'vite';
import solid from 'vite-plugin-solid';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tempDir } from './helpers';
import type { TestNode } from './sectionSplitHarness';

const ROOT = join(import.meta.dirname, '..');
const ENTRY = join(ROOT, 'tests/virtual-section-split.tsx').replaceAll('\\', '/');
const STATE = 'test:settings-state';
const ENTRY_SOURCE = `
import { createSignal, onCleanup } from 'solid-js';
import { SectionSplit, SectionsPage } from '@/views/settings/SettingsLayout';
import { node, render } from '${join(import.meta.dirname, 'sectionSplitHarness.ts').replaceAll('\\', '/')}';
import { setSettingsSections } from '${STATE}';
export function mount(settings = false) {
  const [open, setOpen] = createSignal('beta');
  const [revision, setRevision] = createSignal(0);
  const events = [], lifetimes = [];
  const body = id => () => {
    lifetimes.push('mount ' + id);
    onCleanup(() => lifetimes.push('dispose ' + id));
    return <p>{id} body {revision()}</p>;
  };
  const actions = id => () => {
    lifetimes.push('actions ' + id);
    onCleanup(() => lifetimes.push('dispose actions ' + id));
    return <button>{id} action</button>;
  };
  const sections = [
    { id: 'alpha', label: 'Alpha', group: 'First', meta: () => 'Ready', aside: () => <input type="checkbox" />, muted: () => true, body: body('alpha'), actions: actions('alpha') },
    { id: 'beta', label: 'Beta', title: 'Beta title', group: 'Second', divider: true, link: { href: 'https://example.com', label: 'Site' }, body: body('beta'), actions: actions('beta') },
  ];
  const railAdd = { label: 'Add', onClick: () => events.push('add') };
  const onOpen = id => events.push(id);
  const root = node('root');
  setSettingsSections({ probe: 'beta' });
  const dispose = render(() => settings
    ? <SectionsPage id="probe" title="Probe" right={<button>Page action</button>} lede="Purpose" notice={<p>Notice</p>} sections={sections} railAdd={railAdd} />
    : <SectionSplit title="Probe" sections={sections} openId={open()} onOpen={onOpen} railAdd={railAdd} />, root);
  return { root, events, lifetimes, dispose, select: setOpen, revise: setRevision, store: id => setSettingsSections({ probe: id }) };
}
`;

interface View {
  root: TestNode;
  events: string[];
  lifetimes: string[];
  select(id: string): void;
  store(id: string): void;
  revise(n: number): void;
  dispose(): void;
}
let mount: (settings?: boolean) => View;
const views: View[] = [];
const open = (settings = false): View => { const view = mount(settings); views.push(view); return view; };
const nodes = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(nodes)];
const text = (node: TestNode): string => node.text + node.children.map(text).join('');
const find = (view: View, tag: string, label: string): TestNode => {
  const node = nodes(view.root).find((node) => node.tag === tag && text(node) === label);
  if (!node) throw new Error(`Missing ${tag}: ${label}`);
  return node;
};
const click = (node: TestNode): void => (node.props.onClick as () => void)();

beforeAll(async () => {
  const output = tempDir();
  const fixture: Plugin = {
    name: 'section-split-fixture',
    resolveId: (id) => id === STATE ? STATE : /virtual-section-split\.tsx$/.test(id) ? ENTRY : undefined,
    load: (id) => id === ENTRY ? ENTRY_SOURCE : id === STATE
      ? "import { createSignal } from 'solid-js'; export const [settingsSections, setSettingsSections] = createSignal({});" : undefined,
  };
  await build({
    root: ROOT, configFile: false, logLevel: 'silent',
    plugins: [fixture, solid({ hot: false, dev: false, solid: { generate: 'universal', moduleName: join(import.meta.dirname, 'sectionSplitHarness.ts').replaceAll('\\', '/') } })],
    resolve: { alias: [
      { find: '@/state/ui', replacement: STATE },
      { find: '@plugin-sdk', replacement: join(ROOT, 'src/plugin-sdk') },
      { find: '@', replacement: join(ROOT, 'src/renderer/src') },
      { find: /^solid-js$/, replacement: join(ROOT, 'node_modules/solid-js/dist/solid.js') },
      { find: /^solid-js\/store$/, replacement: join(ROOT, 'node_modules/solid-js/store/dist/store.js') },
      { find: /^solid-js\/web$/, replacement: join(ROOT, 'node_modules/solid-js/web/dist/web.js') },
    ] },
    ssr: { noExternal: true },
    build: { ssr: ENTRY, outDir: output, rollupOptions: { output: { entryFileNames: 'sectionSplit.mjs' } } },
  });
  ({ mount } = await import(pathToFileURL(join(output, 'sectionSplit.mjs')).href));
});

afterEach(() => views.splice(0).forEach((view) => view.dispose()));

describe('caller-owned section split', () => {
  it('opens only the requested section and reports rail clicks without changing caller state', () => {
    const view = open();
    expect(text(view.root)).toContain('beta body 0');
    expect(view.lifetimes).toEqual(['actions beta', 'mount beta']);
    expect(find(view, 'button', 'Beta').props['aria-current']).toBe('true');
    click(find(view, 'button', 'AlphaReady'));
    expect(view.events).toEqual(['alpha']);
    expect(text(view.root)).toContain('beta body 0');
    view.select('alpha');
    expect(text(view.root)).toContain('alpha body 0');
    expect(text(view.root)).not.toContain('beta body');
    expect(view.lifetimes).toContain('dispose beta');
    expect(view.lifetimes).toContain('dispose actions beta');
    const lifetimes = [...view.lifetimes];
    view.revise(1);
    expect(text(view.root)).toContain('alpha body 1');
    expect(view.lifetimes).toEqual(lifetimes);
  });

  it('retains groups, dividers, meta, aside, muted entries, links, keyed actions and both add buttons', () => {
    const view = open();
    expect(find(view, 'h3', 'First')).toBeDefined();
    expect(find(view, 'h3', 'Second')).toBeDefined();
    expect(find(view, 'h3', 'Beta title')).toBeDefined();
    expect(find(view, 'a', 'Site').props.href).toBe('https://example.com');
    expect(find(view, 'button', 'AlphaReady').parent?.props['data-muted']).toBe('true');
    expect(nodes(view.root).filter((node) => node.tag === 'hr')).toHaveLength(2);
    expect(nodes(view.root).filter((node) => node.tag === 'input')).toHaveLength(1);
    click(find(view, 'button', 'Add'));
    click(find(view, 'button', '+ Add'));
    expect(view.events).toEqual(['add', 'add']);
    const picker = nodes(view.root).find((node) => node.tag === 'select')!;
    (picker.props.onChange as (e: unknown) => void)({ currentTarget: { value: 'alpha' } });
    expect(view.events.at(-1)).toBe('alpha');
    expect(picker.value).toBe('beta');
    expect(text(view.root)).toContain('beta body 0');
  });

  it('keeps Settings page wrappers and head while using persisted Settings selection', () => {
    const view = open(true);
    expect(view.root.children[0]?.props.class).toBe('cp-settings-page');
    expect(view.root.children[0]?.props['aria-labelledby']).toBe('probe-heading');
    expect(find(view, 'h2', 'Probe').props.id).toBe('probe-heading');
    expect(find(view, 'p', 'Purpose')).toBeDefined();
    expect(find(view, 'p', 'Notice')).toBeDefined();
    expect(find(view, 'button', 'Page action')).toBeDefined();
    click(find(view, 'button', 'AlphaReady'));
    expect(text(view.root)).toContain('alpha body 0');
    view.store('missing');
    expect(find(view, 'button', 'AlphaReady').props['aria-current']).toBe('true');
  });
});
