// Valid fixture plugins pass source scans; planted violations identify files and lines.
import { cpSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PluginDescriptor } from '@shared/bundledTypes';
import { scanPlugin, scanWarnings } from '../scripts/pluginScan';
import { REPO_ALL_READERS } from '../scripts/pluginScan/allReaders';
import { tempDir } from './helpers';
import { PLUGINS_DIR } from './rendererGraph';

const CHECK_FIXTURE = join(import.meta.dirname, 'fixtures/checkprobe');

/** The plugin:check fixture copied to a temp folder named `id`, with `files` written over it. */
function pluginFolder(id: string, files: Record<string, string>): string {
  const dir = join(tempDir(), id);
  cpSync(CHECK_FIXTURE, dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

describe("plugin:check's scan", () => {
  it('passes the fixture plugins, the phone transport importing the shell', async () => {
    for (const id of readdirSync(PLUGINS_DIR)) {
      const pluginDir = join(PLUGINS_DIR, id);
      const { default: plugin } = (await import(join(pluginDir, 'shared/index.ts'))) as { default: PluginDescriptor };
      expect(scanPlugin({ pluginDir, isPhoneTransport: plugin.phone?.transport === true }), id).toEqual([]);
    }
    expect(scanPlugin({ pluginDir: CHECK_FIXTURE, isPhoneTransport: false })).toEqual([]);
  });

  it('names each import outside the SDK entries, Node built-ins, its dependencies and its own folder', async () => {
    const dir = pluginFolder('probe', {
      'core/host.ts': "import { openDb } from '@core/db';\nimport type { Db } from '@shared/bundledTypes';\nexport { openDb };\n",
      'core/packages.ts': "import pad from 'left-pad';\nimport { readFileSync } from 'node:fs';\nimport { join } from 'path';\nexport const page = { label: 'Export and import', page: 'archive' };\n",
      'core/outside.ts': "export * from '../../elsewhere';\n",
      'core/net.ts': "\nimport { request } from 'node:https';\nconst tls = await import('tls');\nexport const a = 1; import{get}from'node:http';\nconst net = await import(`net`);\n",
      'core/fromTests.ts': "import { fake } from '../tests/fakes';\nimport { probe } from './probe.test';\n",
      'core/computed.ts': "const name = 'node:https';\nexport const a = await import(name);\nexport const b = require('dgram');\n",
      'renderer/tiers.ts': "import { look } from '@plugin-sdk/renderer/kit/look';\nimport { createSignal } from 'solid-js';\nimport { html } from 'solid-js/html';\n",
      'renderer/page.ts': "import '../page/main';\n",
      'page/main.ts': "import { greeting } from '../shared/greeting';\nimport { startPage } from '@plugin-sdk/renderer/shell';\n",
    });
    const named = (spec: string, why: string): string => `${spec}: ${why}`;
    const other = "not the Plugin SDK, a Node built-in, a package.json dependency or the plugin's own file";
    const expected = [
      'core/computed.ts:2: a computed import: name the module',
      `core/fromTests.ts:1: ${named('../tests/fakes', "test code, which the scan skips: source can't import it")}`,
      `core/fromTests.ts:2: ${named('./probe.test', "test code, which the scan skips: source can't import it")}`,
      `core/host.ts:1: ${named('@core/db', other)}`,
      `core/host.ts:2: ${named('@shared/bundledTypes', other)}`,
      `core/outside.ts:1: ${named('../../elsewhere', 'outside the plugin folder')}`,
      `core/packages.ts:1: ${named('left-pad', other)}`,
      `renderer/page.ts:1: ${named('../page/main', "only the plugin's page/ may import its page")}`,
      `renderer/tiers.ts:1: ${named('@plugin-sdk/renderer/kit/look', 'not an entry the host provides')}`,
      `renderer/tiers.ts:3: ${named('solid-js/html', 'not an entry the host provides')}`,
    ];
    const shell = "page/main.ts:2: @plugin-sdk/renderer/shell: only the phone transport's plugin may import it";
    expect(scanPlugin({ pluginDir: dir, isPhoneTransport: false })).toEqual([...expected, shell]);
    expect(scanPlugin({ pluginDir: dir, isPhoneTransport: true })).toEqual(expected);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { 'left-pad': '1.3.0' } }));
    expect(scanPlugin({ pluginDir: dir, isPhoneTransport: true })).toEqual(expected.filter((v) => !v.includes('left-pad')));
  });

  it("warns of, without failing, Node network modules and Discord's API or gateway named in a string; not links or media", () => {
    const dir = pluginFolder('probe', {
      'core/net.ts': "\nimport { request } from 'node:https';\nconst tls = await import('tls');\nexport const b = require('dgram');\n",
      'main/discord.ts': [
        "export const api = 'https://discord.com/api/v9/users/@me';",
        'export const old = (id: string) => `https://discordapp.com/api/channels/${id}`;',
        "export const socket = 'wss://gateway-us-east1-b.discord.gg/?v=9';",
        "export const jump = 'https://discord.com/channels/1/2/3';",
        "export const avatar = 'https://cdn.discordapp.com/avatars/1/a.png';",
        "export const elsewhere = 'https://example.com/api/v9';",
      ].join('\n'),
    });
    expect(scanPlugin({ pluginDir: dir, isPhoneTransport: false })).toEqual([]);
    const module = (spec: string): string => `${spec}: a Node network module skips ctx.net's declared hosts; never reach Discord with it`;
    const discord = (url: string): string => `${url}: Discord's API or gateway; reach Discord through ctx.discord, never a request of the plugin's own`;
    expect(scanWarnings(dir)).toEqual([
      `core/net.ts:2: ${module('node:https')}`,
      `core/net.ts:3: ${module('tls')}`,
      `core/net.ts:4: ${module('dgram')}`,
      `main/discord.ts:1: ${discord('https://discord.com/api/v9/users/@me')}`,
      `main/discord.ts:2: ${discord('https://discordapp.com/api/channels/')}`,
      `main/discord.ts:3: ${discord('wss://gateway-us-east1-b.discord.gg/?v=9')}`,
    ]);
  });

  it('names literal table prefixes, global app access and unprefixed user-select; warns of global web requests', async () => {
    const dir = pluginFolder('my-probe', {
      'core/table.ts': "export const ROWS = 'p_my_probe_rows';\n",
      'core/globals.ts': [
        '// fetch and globalThis in a comment are fine; ctx.net.fetch, `fetch:` and sec-fetch-site too.',
        "export const a = (ctx: Ctx) => ctx.net.fetch('x');",
        "export const b = { fetch: 1, header: 'sec-fetch-site' };",
        "export const c = () => fetch('https://example.com');",
        'export const d = globalThis;',
        'export const e = window.chattypop;',
        "export const f = window['chattypop'];",
        "export const g = () => window.fetch('x');",
        "export const h = () => new WebSocket('wss://x');",
        "export const i = () => navigator.sendBeacon('x');",
        'export const j = createRequire(import.meta.url);',
        'export const k = EventSource.CLOSED;',
        "const u = 'https://x'; export const l = () => fetch(u);",
        'const strip = /[`*]/g; export const m = () => fetch(String(strip));',
        "export const n = 'fetch globalThis createRequire';",
      ].join('\n'),
      'renderer/Select.module.css': '.line {\n  user-select: none;\n}\n',
    });
    const reach = "reach the app through the plugin's contexts";
    expect(scanPlugin({ pluginDir: dir, isPhoneTransport: false })).toEqual([
      `core/globals.ts:5: globalThis: ${reach}`,
      `core/globals.ts:6: .chattypop: ${reach}`,
      `core/globals.ts:7: ['chattypop']: ${reach}`,
      `core/globals.ts:11: createRequire: ${reach}`,
      'core/table.ts:1: literal table prefix p_my_probe_: name tables with pluginTable or ctx.storage',
      'renderer/Select.module.css:2: user-select: none needs -webkit-user-select: none beside it',
    ]);
    const web = (what: string): string => `${what}: skips ctx.net's declared hosts (the renderer's CSP refuses other origins); never reach Discord with it`;
    expect(scanWarnings(dir)).toEqual([
      `core/globals.ts:4: ${web('fetch')}`,
      `core/globals.ts:8: ${web('window.fetch')}`,
      `core/globals.ts:9: ${web('new WebSocket')}`,
      `core/globals.ts:10: ${web('.sendBeacon')}`,
      `core/globals.ts:13: ${web('fetch')}`,
      `core/globals.ts:14: ${web('fetch')}`,
    ]);
  });

  it('checks SQL against its own tables and the all-data allowlist, which names its files by plugin folder', async () => {
    const tables = "import { pluginTable } from '@plugin-sdk/shared';\nimport plugin from '../shared';\nexport const OWN = pluginTable(plugin, 'rows');\n";
    const dir = pluginFolder('stats', {
      'core/tables.ts': tables,
      'core/stats.ts': "import { OWN } from './tables';\nexport const q = `SELECT * FROM archive_all_messages JOIN ${OWN} o ON 1`;\n",
      'core/other.ts': "\nexport const q = 'SELECT * FROM archive_all_channels';\nexport const r = 'SELECT * FROM messages';\n",
    });
    expect(scanPlugin({ pluginDir: dir, isPhoneTransport: false })).toEqual([
      'core/other.ts:2: unlisted all-data read: archive_all_channels',
      'core/other.ts:3: host or unknown table: messages',
    ]);
    writeFileSync(join(dir, 'core/stats.ts'), "export const q = 'SELECT * FROM archive_messages';\n");
    writeFileSync(join(dir, 'core/other.ts'), '');
    expect(scanPlugin({ pluginDir: dir, isPhoneTransport: false })).toEqual([
      'core/stats.ts: listed in scripts/pluginScan/allReaders.ts, but reads no archive_all_ view',
    ]);
  });

  it("adds a plugin repo's own all-data grants, beside its plugins folder, to the host's", () => {
    const repo = tempDir();
    const dir = join(repo, 'plugins', 'probe');
    cpSync(CHECK_FIXTURE, dir, { recursive: true });
    writeFileSync(join(dir, 'core/reader.ts'), "export const q = 'SELECT * FROM archive_all_messages';\n");
    const grant = (listed: unknown): void => writeFileSync(join(repo, REPO_ALL_READERS), JSON.stringify(listed));
    expect(scanPlugin({ pluginDir: dir, isPhoneTransport: false })).toEqual(['core/reader.ts:1: unlisted all-data read: archive_all_messages']);
    grant({ 'probe/core/reader.ts': 'Reads every message.', 'probe/core/gone.ts': 'Read once.' });
    expect(scanPlugin({ pluginDir: dir, isPhoneTransport: false })).toEqual([
      `core/gone.ts: listed in ${REPO_ALL_READERS}, but reads no archive_all_ view`,
    ]);
    grant({ 'probe/core/reader.ts': '' });
    expect(() => scanPlugin({ pluginDir: dir, isPhoneTransport: false })).toThrow(REPO_ALL_READERS);
  });

  it('scans source only: never tests, test files, packages or the page’s static files', async () => {
    const fault = "import { openDb } from '@core/db';\nexport const get = () => fetch('x');\n";
    const dir = pluginFolder('probe', {
      'tests/helper.ts': fault,
      'core/thing.test.ts': fault,
      'node_modules/pkg/index.js': fault,
      'core/node_modules/pkg/index.js': fault,
      'page/public/sw.js': fault,
    });
    expect(scanPlugin({ pluginDir: dir, isPhoneTransport: false })).toEqual([]);
    expect(scanWarnings(dir)).toEqual([]);
  });

  it('names a manifest whose version release stamping can’t rewrite (tests/pluginStamp.test.ts)', () => {
    const dir = pluginFolder('probe', { 'shared/index.ts': "import { definePlugin } from '@plugin-sdk/shared';\nconst V = '1.0.0';\nexport default definePlugin({ manifest: { id: 'probe', version: V } });\n" });
    expect(scanPlugin({ pluginDir: dir, isPhoneTransport: false })).toEqual(["shared/index.ts:1: the definePlugin manifest can't be stamped: its `version` must be a string literal"]);
  });
});
