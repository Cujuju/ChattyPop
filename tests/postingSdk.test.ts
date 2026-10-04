// The posting tier (docs/plugin-architecture.md §4): a plugin imports every export of @plugin-sdk/renderer/posting,
// in the dev registry (plugin:check's scan) and installed (the build reads the host's published namespace).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HOST_MODULES, HOST_MODULES_KEY, type InstalledManifest } from '@shared/installedPlugins';
import { buildInstalledPlugin } from '@main/pluginBuild';
import { scanPlugin } from '../scripts/pluginScan';
import { tempDir } from './helpers';

const POSTING = '@plugin-sdk/renderer/posting';
const ROOT = resolve(import.meta.dirname, '..');
/** The posting tier's value exports as tests/sdkSurface.test.ts holds them to its source. */
const NAMES: string[] = (JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/sdkSurface.json'), 'utf8')) as { modules: Record<string, string[]> }).modules[POSTING] ?? [];
/** A build evaluates the plugin's descriptor and runs two Vite builds. */
const BUILD_TIMEOUT_MS = 120_000;

/** A plugin folder whose renderer imports every posting export by name. */
function postingPlugin(): string {
  const dir = join(tempDir(), 'posting-probe');
  const files = {
    'shared/index.ts': "import { definePlugin } from '@plugin-sdk/shared';\nexport default definePlugin({ manifest: { id: 'posting-probe', name: 'Posting probe', version: '1.0.0', description: '' } });\n",
    'renderer/index.tsx': `import { ${NAMES.join(', ')} } from '${POSTING}';\nexport const used = [${NAMES.join(', ')}];\nexport default {};\n`,
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[HOST_MODULES_KEY];
});

describe('the posting SDK tier', () => {
  it('is a browser host module the renderer publishes, never a node one', () => {
    expect(NAMES.length).toBeGreaterThan(0);
    expect(HOST_MODULES.browser).toContain(POSTING);
    expect(HOST_MODULES.node).not.toContain(POSTING);
  });

  it("passes plugin:check's scan when a plugin imports every export", () => {
    expect(scanPlugin({ pluginDir: postingPlugin(), isPhoneTransport: false })).toEqual([]);
  });

  describe('installed', () => {
    let manifest: InstalledManifest;
    beforeAll(async () => {
      (globalThis as Record<symbol, unknown>)[HOST_MODULES_KEY] = { '@plugin-sdk/shared': await import('@plugin-sdk/shared') };
      manifest = await buildInstalledPlugin({ pluginDir: postingPlugin(), outDir: tempDir(), appVersion: '1.0.0', repoRoot: ROOT });
    }, BUILD_TIMEOUT_MS);

    it('reads every export from the host, which checks each against its published namespace at load', () => {
      expect(manifest.hostImports[POSTING]).toEqual([...NAMES].sort());
    });
  });
});
