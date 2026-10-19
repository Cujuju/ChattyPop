// Isolated test app: no windows, profile or connection to a running ChattyPop instance.
const { app, utilityProcess } = require('electron');
// The parent owns this disposable folder and removes it after the launcher exits.
const profile = process.argv[4];
if (!profile) throw new Error('An isolated probe profile folder is required');
app.setPath('userData', profile);
app.whenReady().then(() => {
  const proc = utilityProcess.fork(process.argv[2], [], { stdio: 'pipe' });
  proc.stderr.on('data', (data) => process.stderr.write(data));
  let sending = 0;
  let exitCode;
  const finish = () => { if (exitCode !== undefined && !sending) app.exit(exitCode); };
  proc.on('spawn', () => proc.postMessage({ path: process.argv[3] }));
  proc.on('message', (message) => {
    sending++;
    process.send(message, () => { sending--; finish(); });
  });
  proc.on('exit', (code) => { exitCode = code; finish(); });
});
