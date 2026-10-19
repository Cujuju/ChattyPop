// Opt-in synthetic benchmark; never opens the user's archive or starts Electron.
import { join, resolve } from 'node:path';
import { runnerImport } from 'vite';

const plugins = resolve(process.argv[2] ?? '');
const host = resolve(process.env.WRITE_BENCH_HOST ?? '.');
if (!process.argv[2]) throw new Error('Usage: node scripts/benchArchiveWrites.mjs <public plugins directory>');
process.env.VITEST = '1';
console.log('Loading benchmark configuration');
const { module: configuration } = await runnerImport(join(host, 'vitest.config.ts'), { configFile: false });
const config = configuration.testConfig({ dirs: plugins, selection: 'attachments,links,stats' });
config.resolve.alias.push({ find: 'tldts', replacement: join(plugins, 'stats/node_modules/tldts/dist/es6/index.js').replaceAll('\\', '/') });
const packages = {
  name: 'write-bench-packages',
  async resolveId(source, importer, options) {
    if (!importer || !/^(?:@[\w.-]+\/)?[\w.-]+(?:\/.*)?$/.test(source)) return;
    const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      ?? await this.resolve(source, resolve('package.json'), { ...options, skipSelf: true });
    if (resolved?.id.includes('/node_modules/') && !resolved.id.endsWith('.json')) return { ...resolved, external: true };
    return resolved;
  },
};
const virtual = '\0write-bench-plugins';
const sources = {
  attachments: 'attachments/core/index.ts', links: 'links/core/index.ts', stats: 'stats/core/index.ts',
  seed: 'attachments/tests/bench/fixture.ts',
};
const fixture = {
  name: 'write-bench-plugins',
  resolveId(source) { if (source === 'write-bench-plugins') return virtual; },
  load(id) {
    if (id !== virtual) return;
    return Object.entries(sources).map(([name, file]) => name === 'seed'
      ? `export { seed, CHANNEL } from ${JSON.stringify(join(plugins, file).replaceAll('\\', '/'))};`
      : `export { default as ${name} } from ${JSON.stringify(join(plugins, file).replaceAll('\\', '/'))};`).join('\n');
  },
};
const { module } = await runnerImport(join(import.meta.dirname, process.env.WRITE_BENCH_ENTRY ?? 'bench/archiveWrites.ts'), {
  configFile: false, logLevel: 'silent', resolve: config.resolve, define: config.define, plugins: [...config.plugins, fixture, packages],
});
console.log('Running write benchmark');
await module.main();
