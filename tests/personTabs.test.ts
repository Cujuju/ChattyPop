// The Person window places plugin tabs, draws their panels and resets selection when their owner disappears.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { build, type Plugin } from 'vite';
import solid from 'vite-plugin-solid';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tempDir } from './helpers';
import type { TestNode } from './sectionSplitHarness';

const ROOT = join(import.meta.dirname, '..');
const ENTRY = join(ROOT, 'tests/virtual-person-tabs.tsx').replaceAll('\\', '/');
const HARNESS = join(import.meta.dirname, 'sectionSplitHarness.ts').replaceAll('\\', '/');
const STATE = 'test:person-tabs-state';
const ADAPTER = 'test:person-tabs-adapter';
const MOCKED = [
  '@/plugins/slots', '@/state/person', '@/state/clock', '@/state/archive', '@/state/search',
  '@/panels/chat/PersonName', '@/ui/GuildIcon', '@/ui/icons', '@/ui/scrollEdges', '@/theme/look',
];
const STATE_SOURCE = `
import { createSignal } from 'solid-js';
import { node } from '${HARNESS}';
import { readSlots } from '@/plugins/readSlots';
import { anchorCatalog, catalogSlotAnchor } from '@shared/bundledCheck';
export const [enabled, setEnabled] = createSignal(true);
export const [discord, setDiscord] = createSignal(null);
const declarations = [
  { id: 'files', after: 'links' },
  { id: 'serverFiles', after: 'servers' },
  { id: 'friendFiles', after: 'friends' },
];
const plugin = { manifest: { id: 'probe', name: 'Probe', version: '1', description: '' }, slots: { personTabs: declarations } };
const labels = { files: 'Files', serverFiles: 'Server files', friendFiles: 'Friend files' };
const contributions = { personTabs: Object.fromEntries(declarations.map(({ id }) => [id, {
  label: labels[id], Component: props => node('p', labels[id] + ' for ' + props.userId),
}])) };
export const personTabs = readSlots(() => [{ plugin, contributions }], enabled, () => true, catalogSlotAnchor(anchorCatalog([plugin]))).personTabs;
export const personLinks = () => null, personSections = () => [];
export const discordProfile = { value: discord }, mutualFriends = { value: () => null, loading: () => false, stale: () => false };
export const showMutualFriends = () => {}, openPerson = () => {}, openArchive = () => {};
export const now = () => 0, today = () => 0, scrolledFromTop = () => 0;
export const showSearch = () => {};
export const PersonName = () => null, GuildIcon = () => null, Icon = () => null;
export const look = {};
`;
const ENTRY_SOURCE = `
import { createSignal } from 'solid-js';
import { PersonTabs } from '@/views/person/PersonTabs';
import { node, render } from '${HARNESS}';
import { setEnabled, setDiscord } from '${STATE}';
export function mount() {
  setEnabled(true); setDiscord(null);
  const [person, setPerson] = createSignal({
    id: 'first', channels: [], links: [], nicknames: [], firstTs: null, lastTs: null,
    totals: { messages: 0, edited: 0, deleted: 0, links: 0, attachments: 0 },
  });
  const root = node('root');
  const dispose = render(() => <PersonTabs p={person()} />, root);
  return { root, dispose, enable: setEnabled, discord: setDiscord, person: id => setPerson({ ...person(), id }) };
}
`;

interface View {
  root: TestNode;
  dispose(): void;
  enable(value: boolean): void;
  discord(value: { mutualGuilds: { id: string; name: string }[]; mutualFriendsCount: number } | null): void;
  person(id: string): void;
}
let mount: () => View;
const views: View[] = [];
const nodes = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(nodes)];
const text = (node: TestNode): string => node.text + node.children.map(text).join('');
const tabs = (view: View): TestNode[] => nodes(view.root).filter((node) => node.props.role === 'tab');
const panel = (view: View): TestNode => nodes(view.root).find((node) => node.props.role === 'tabpanel')!;
const open = (): View => { const view = mount(); views.push(view); return view; };
const pick = (view: View, label: string): void => {
  const tab = tabs(view).find((node) => text(node) === label);
  if (!tab) throw new Error(`Missing tab: ${label}`);
  (tab.props.onClick as () => void)();
};
const selected = (view: View): string => text(tabs(view).find((node) => node.props['aria-selected'])!);

beforeAll(async () => {
  vi.stubGlobal('document', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const output = tempDir();
  const fixture: Plugin = {
    name: 'person-tabs-fixture',
    resolveId: (id) => id === STATE || id === ADAPTER ? id : /virtual-person-tabs\.tsx$/.test(id) ? ENTRY : undefined,
    load: (id) => id === ENTRY ? ENTRY_SOURCE : id === STATE ? STATE_SOURCE : id === ADAPTER ? `
      export * from '${HARNESS}';
      import { createElement as element } from '${HARNESS}';
      export const createElement = tag => { const n = element(tag); n.closest = () => null; return n; };
    ` : undefined,
  };
  await build({
    root: ROOT, configFile: false, logLevel: 'silent',
    plugins: [fixture, solid({ hot: false, dev: false, solid: { generate: 'universal', moduleName: ADAPTER } })],
    resolve: { alias: [
      ...MOCKED.map((find) => ({ find, replacement: STATE })),
      { find: '@plugin-sdk', replacement: join(ROOT, 'src/plugin-sdk') },
      { find: '@shared', replacement: join(ROOT, 'src/shared') },
      { find: '@', replacement: join(ROOT, 'src/renderer/src') },
      { find: /^solid-js$/, replacement: join(ROOT, 'node_modules/solid-js/dist/solid.js') },
      { find: /^solid-js\/store$/, replacement: join(ROOT, 'node_modules/solid-js/store/dist/store.js') },
      { find: /^solid-js\/web$/, replacement: join(ROOT, 'node_modules/solid-js/web/dist/web.js') },
    ] },
    ssr: { noExternal: true },
    build: { ssr: ENTRY, outDir: output, rollupOptions: { output: { entryFileNames: 'personTabs.mjs' } } },
  });
  ({ mount } = await import(pathToFileURL(join(output, 'personTabs.mjs')).href));
});

afterEach(() => views.splice(0).forEach((view) => view.dispose()));
afterAll(() => vi.unstubAllGlobals());

it('draws a plugin panel for the selected person and returns to Channels when the plugin is off', () => {
  const view = open();
  expect(tabs(view).map(text)).toEqual(['Where they post', 'Links', 'Files', 'Server files', 'Friend files']);
  pick(view, 'Files');
  expect(selected(view)).toBe('Files');
  expect(text(panel(view))).toBe('Files for first');
  view.enable(false);
  expect(tabs(view).map(text)).toEqual(['Where they post', 'Links']);
  expect(selected(view)).toBe('Where they post');
  expect(text(panel(view))).toBe('No archived messages from them.');
});

it('resets to Channels for another person and passes the new user id when the plugin tab opens', () => {
  const view = open();
  pick(view, 'Files');
  view.person('second');
  expect(selected(view)).toBe('Where they post');
  pick(view, 'Files');
  expect(text(panel(view))).toBe('Files for second');
});

it('places tabs beside conditional host anchors before hiding those hosts, preserving host counts and titles', () => {
  const view = open();
  view.discord({ mutualGuilds: [{ id: 'guild', name: 'Guild' }], mutualFriendsCount: 1 });
  expect(tabs(view).map(text)).toEqual(['Where they post', 'Links', 'Files', 'Servers1', 'Server files', 'Friends1', 'Friend files']);
  expect(tabs(view).find((node) => text(node) === 'Servers1')?.props.title).toBe('Mutual servers');
  expect(tabs(view).find((node) => text(node) === 'Friends1')?.props.title).toBe('Mutual friends');
  view.discord(null);
  expect(tabs(view).map(text)).toEqual(['Where they post', 'Links', 'Files', 'Server files', 'Friend files']);
});
