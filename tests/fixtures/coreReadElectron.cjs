// A disposable profile and archive; this launcher never opens a window or connects to the user's app.
const { app, utilityProcess } = require('electron');
const { join } = require('node:path');
const [entry, archiveDir, profile] = process.argv.slice(2);
if (!archiveDir || !profile) throw new Error('An isolated archive and profile are required');
app.setPath('userData', profile);
app.whenReady().then(() => {
  const core = utilityProcess.fork(entry, [], { stdio: 'pipe' });
  core.stderr.on('data', (data) => process.stderr.write(data));
  const faults = [];
  let directoryCount;
  core.on('spawn', () => {
    core.postMessage({ kind: 'init', archiveDir, pluginsDir: join(profile, 'plugins'),
      pluginData: { root: join(profile, 'plugin-data'), unmoved: {} }, key: null,
      openRouterKeys: [], typeSafeKey: null, providerApiKeys: {} });
    core.postMessage({ id: 1, method: 'directory', params: [] });
  });
  core.on('message', (message) => {
    if (message.kind === 'diag' && /^archive-read-helper-/.test(message.event)) faults.push(message);
    if (message.id === 1) {
      if (!message.ok || !Array.isArray(message.result)) {
        process.send({ ok: false, coreBundle: true, error: message.error, faults }, () => core.kill());
        return;
      }
      directoryCount = message.result.length;
      core.postMessage({ id: 2, method: 'closeArchive', params: [] });
    }
    if (message.id === 2) {
      // Flush IPC before the disposable process exits; otherwise the parent can observe exit before its answer.
      process.send({ ok: message.ok && !faults.length, coreBundle: true, directoryCount, faults, error: message.error }, () => core.kill());
    }
  });
  core.on('exit', () => app.exit(0));
});
