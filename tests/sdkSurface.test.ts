// Plugin SDK's version follows its surface (docs/plugin-architecture.md §16): each SDK module's export names are
// recorded with their shipped version, so adding or removing one without a bump fails here.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from '@babel/parser';
import { describe, expect, it } from 'vitest';
import { HOST_MODULES, PLUGIN_SDK_VERSION, compareVersions } from '@shared/installedPlugins';

/** The recorded surface: the version and each SDK module's sorted export names. */
const RECORD = join(import.meta.dirname, 'fixtures/sdkSurface.json');
/** Set to write the record once the version is raised. */
const UPDATE_ENV = 'UPDATE_SDK_SURFACE';
const SDK_MODULES = [...new Set([...HOST_MODULES.node, ...HOST_MODULES.browser])].filter((id) => id.startsWith('@plugin-sdk/'));

interface Surface {
  version: string;
  modules: Record<string, string[]>;
}

const SDK_ROOT = join(import.meta.dirname, '../src/plugin-sdk');
/** The alias the SDK's modules re-export host modules through. */
const SHARED_ALIAS = '@shared/';
const SHARED_ROOT = join(import.meta.dirname, '../src/shared');
/** A module file a specifier names: `x.ts`, `x.tsx` or `x/index.ts(x)`. */
const moduleFile = (base: string): string => {
  const file = [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')].find((f) => existsSync(f));
  if (!file) throw new Error(`no module at ${base}`);
  return file;
};

/** The value names `file` exports, read from its source (types are erased, so they aren't part of the surface). */
function exportNames(file: string): string[] {
  const program = parse(readFileSync(file, 'utf8'), { sourceType: 'module', plugins: file.endsWith('x') ? ['typescript', 'jsx'] : ['typescript'] }).program;
  return program.body.flatMap((node): string[] => {
    if (node.type === 'ExportDefaultDeclaration') return ['default'];
    if (node.type === 'ExportAllDeclaration') {
      if (node.exportKind === 'type') return [];
      const spec = node.source.value;
      if (spec.startsWith('.')) return exportNames(moduleFile(resolve(dirname(file), spec)));
      return spec.startsWith(SHARED_ALIAS) ? exportNames(moduleFile(join(SHARED_ROOT, spec.slice(SHARED_ALIAS.length)))) : [`* from ${spec}`];
    }
    if (node.type !== 'ExportNamedDeclaration' || node.exportKind === 'type') return [];
    const d = node.declaration;
    // `export * as ns from` is a namespace specifier here.
    if (!d) return node.specifiers.flatMap((sp) => (sp.type === 'ExportSpecifier' && sp.exportKind === 'type' ? [] : [sp.exported.type === 'Identifier' ? sp.exported.name : sp.exported.value]));
    if (d.type === 'VariableDeclaration') return d.declarations.flatMap((v) => (v.id.type === 'Identifier' ? [v.id.name] : []));
    if (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration' || d.type === 'TSEnumDeclaration') return d.id ? [d.id.name] : [];
    return [];
  });
}

/** Which part of an x.y.z version a change to the surface must raise; null when none changed. */
function neededBump(recorded: Surface, now: Surface): { part: 'major' | 'minor'; names: string[] } | null {
  const diff = (from: Surface, to: Surface): string[] =>
    SDK_MODULES.flatMap((id) => (from.modules[id] ?? []).filter((n) => !(to.modules[id] ?? []).includes(n)).map((n) => `${id} ${n}`));
  const removed = diff(recorded, now);
  if (removed.length) return { part: 'major', names: removed };
  const added = diff(now, recorded);
  return added.length ? { part: 'minor', names: added } : null;
}

const part = (version: string, at: 0 | 1): number => Number(version.split('.')[at]);

describe('the Plugin SDK surface', () => {
  it('is recorded at the current PLUGIN_SDK_VERSION; a change raises it (minor: additions, major: removals)', () => {
    const now: Surface = { version: PLUGIN_SDK_VERSION, modules: {} };
    for (const id of SDK_MODULES) now.modules[id] = [...new Set(exportNames(moduleFile(join(SDK_ROOT, id.slice('@plugin-sdk/'.length)))))].sort();
    const recorded = JSON.parse(readFileSync(RECORD, 'utf8')) as Surface;
    const bump = neededBump(recorded, now);
    if (bump) {
      const raised = bump.part === 'major' ? part(PLUGIN_SDK_VERSION, 0) > part(recorded.version, 0) : compareVersions(PLUGIN_SDK_VERSION, recorded.version) > 0;
      expect(raised, `${bump.names.join(', ')} changed since SDK ${recorded.version}: raise the ${bump.part} of PLUGIN_SDK_VERSION`).toBe(true);
      // Raised: record the new surface, so the next change compares against it.
      if (process.env[UPDATE_ENV]) writeFileSync(RECORD, `${JSON.stringify(now, null, 2)}
`);
      expect(process.env[UPDATE_ENV], `record it: ${UPDATE_ENV}=1 pnpm exec vitest run tests/sdkSurface.test.ts`).toBeTruthy();
    } else expect(PLUGIN_SDK_VERSION, 'the version changed with no surface change').toBe(recorded.version);
  });
});
