import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { build, type Plugin } from 'vite';
import solid from 'vite-plugin-solid';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tempDir } from './helpers';
import type { TestNode } from './sectionSplitHarness';

const ROOT = join(import.meta.dirname, '..');
const ENTRY = join(ROOT, 'tests/virtual-rule-picker.tsx').replaceAll('\\', '/');
const HARNESS = join(import.meta.dirname, 'sectionSplitHarness.ts').replaceAll('\\', '/');
const ADAPTER = 'test:rule-picker-adapter';
const API = 'test:rule-picker-api';
const VIEWPORT_PX = 1024;
const ENTRY_SOURCE = `
import { AddPicker } from '@/views/settings/rules/pickers';
import { node, render } from '${HARNESS}';
export { dispatchAppEvent as emit } from '@plugin-sdk/renderer/appEvents';
export function mount() {
  const pending = [], picked = [];
  const root = node('root');
  const dispose = render(() => <AddPicker label="Who" search={query => new Promise(answer => pending.push({ query, answer }))} onPick={value => picked.push(value)} />, root);
  return { root, dispose, pending, picked };
}
`;
interface Option { value: string; label: string }
interface View {
  root: TestNode;
  dispose(): void;
  pending: { query: string; answer(options: Option[]): void }[];
  picked: string[];
}
let mount: () => View;
let emit: (event: { type: 'privacy-changed' }) => void;
const nodes = (node: TestNode): TestNode[] => [node, ...node.children.flatMap(nodes)];
const options = (view: View): TestNode[] => nodes(view.root).filter((node) => node.props.role === 'option');
const text = (node: TestNode): string => node.text + node.children.map(text).join('');
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve));

beforeAll(async () => {
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('document', { getElementById: () => null });
  vi.stubGlobal('innerWidth', VIEWPORT_PX);
  vi.stubGlobal('innerHeight', VIEWPORT_PX);
  const output = tempDir();
  const fixture: Plugin = {
    name: 'rule-picker-fixture',
    resolveId: (id) => id === ADAPTER || id === API ? id : /virtual-rule-picker\.tsx$/.test(id) ? ENTRY : undefined,
    load: (id) => id === ENTRY ? ENTRY_SOURCE : id === API ? `
      export const api = { onEvent: () => () => {} };
      export const Icon = () => null;
    ` : id === ADAPTER ? `
      export * from '${HARNESS}';
      import { createElement as element } from '${HARNESS}';
      export const createElement = tag => {
        const n = element(tag);
        n.style = {};
        n.getBoundingClientRect = () => ({ left: 0, top: 0, bottom: 0, width: 0, height: 0 });
        return n;
      };
    ` : undefined,
  };
  await build({
    root: ROOT, configFile: false, logLevel: 'silent',
    plugins: [fixture, solid({ hot: false, dev: false, solid: { generate: 'universal', moduleName: ADAPTER } })],
    resolve: { alias: [
      { find: '@/api', replacement: API }, { find: '@/ui/icons', replacement: API },
      { find: '@plugin-sdk', replacement: join(ROOT, 'src/plugin-sdk') },
      { find: '@shared', replacement: join(ROOT, 'src/shared') },
      { find: '@', replacement: join(ROOT, 'src/renderer/src') },
      { find: /^solid-js$/, replacement: join(ROOT, 'node_modules/solid-js/dist/solid.js') },
      { find: /^solid-js\/store$/, replacement: join(ROOT, 'node_modules/solid-js/store/dist/store.js') },
      { find: /^solid-js\/web$/, replacement: join(ROOT, 'node_modules/solid-js/web/dist/web.js') },
    ] },
    ssr: { noExternal: true },
    build: { ssr: ENTRY, outDir: output, rollupOptions: { output: { entryFileNames: 'rulePicker.mjs' } } },
  });
  ({ mount, emit } = await import(pathToFileURL(join(output, 'rulePicker.mjs')).href));
});

afterAll(() => vi.unstubAllGlobals());

it.each([false, true])('invalidates the open Who search on privacy changes, with cached results: %s', async (cached) => {
  const view = mount();
  try {
    const button = nodes(view.root).find((node) => node.tag === 'button')!;
    (button.props.onClick as () => void)();
    const input = nodes(view.root).find((node) => node.tag === 'input')!;
    (input.props.onInput as (event: { currentTarget: { value: string } }) => void)({ currentTarget: { value: 'name' } });
    const privateOptions = [{ value: 'private', label: 'Private name' }];
    if (cached) {
      view.pending.shift()!.answer(privateOptions);
      await settle();
      expect(options(view).map(text)).toEqual(['Private name']);
    }
    emit({ type: 'privacy-changed' });
    expect(options(view)).toEqual([]);
    if (!cached) {
      view.pending.shift()!.answer(privateOptions);
      await settle();
      expect(options(view)).toEqual([]);
    }
    view.pending.shift()!.answer([{ value: 'visible', label: 'Visible name' }]);
    await settle();
    expect(options(view).map(text)).toEqual(['Visible name']);
    (options(view)[0]!.props.onMouseDown as (event: { preventDefault(): void }) => void)({ preventDefault() {} });
    expect(view.picked).toEqual(['visible']);
  } finally {
    view.dispose();
  }
  emit({ type: 'privacy-changed' });
  expect(view.pending).toEqual([]);
});
