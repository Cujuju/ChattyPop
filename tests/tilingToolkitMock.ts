// Load only pure toolkit modules: its public entry also initializes browser components.
export async function loadToolkit(): Promise<Record<string, unknown>> {
  const source = '../node_modules/@cujuju/solidjs-tiling-window-manager/src/';
  const modules = await Promise.all(['tileTree', 'tileEdits', 'tileCollapse', 'tileRepair'].map((name) => import(`${source}${name}.ts`)));
  return Object.assign({}, ...modules);
}
