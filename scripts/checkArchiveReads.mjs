// After build and archiveReads.test.ts: verify the production reader entries and native binary inside ASAR.
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fork } from 'node:child_process';
import { createPackageWithOptions } from '@electron/asar';

/** Bound a broken Electron probe; only its own launcher is terminated. */
const PROBE_TIMEOUT_MS = 15_000;
const repo = resolve(import.meta.dirname, '..');
const stage = join(repo, 'out/package-read-stage');
const main = join(stage, 'out/main');
mkdirSync(main, { recursive: true });
cpSync(join(repo, 'out/read-tests'), main, { recursive: true });
for (const entry of ['archiveReadProcess.js', 'archiveReadWorker.js']) cpSync(join(repo, 'out/main', entry), join(main, entry));
cpSync(join(repo, 'out/main/chunks'), join(main, 'chunks'), { recursive: true });
writeFileSync(join(stage, 'package.json'), JSON.stringify({ type: 'module' }));
const require = createRequire(import.meta.url);
const native = dirname(require.resolve('better-sqlite3-multiple-ciphers/package.json'));
const target = join(stage, 'node_modules/better-sqlite3-multiple-ciphers');
mkdirSync(join(target, 'prebuilds'), { recursive: true });
cpSync(join(native, 'lib'), join(target, 'lib'), { recursive: true });
cpSync(join(native, 'package.json'), join(target, 'package.json'));
cpSync(join(native, 'prebuilds', `${process.platform}-${process.arch}.node`), join(target, 'prebuilds', `${process.platform}-${process.arch}.node`));
const asar = join(repo, 'out/archive-read-fixture.asar');
await createPackageWithOptions(stage, asar, { unpack: '**/prebuilds/**' });
const path = join(repo, 'out/package-read.db');
const db = new DatabaseSync(path);
db.exec(`CREATE TABLE IF NOT EXISTS archive_messages (id TEXT);
  CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY, id TEXT);
  INSERT OR IGNORE INTO messages(seq, id) VALUES (1, 'probe');
  INSERT INTO archive_messages SELECT 'probe' WHERE NOT EXISTS (SELECT 1 FROM archive_messages WHERE id = 'probe');`);
db.close();
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const profile = join(repo, 'out/package-read-profile');
mkdirSync(profile, { recursive: true });
const child = fork(join(repo, 'tests/fixtures/archiveReadElectron.cjs'), [join(asar, 'out/main/archiveReadProbe.js'), path, profile], {
  execPath: require('electron'), env, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
});
let stderr = '';
child.stderr.on('data', (data) => stderr += String(data));
const exited = new Promise((resolve) => child.once('exit', resolve));
const timer = setTimeout(() => child.kill(), PROBE_TIMEOUT_MS);
try {
  const result = await new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Probe exited ${code}: ${stderr}`)));
  });
  console.log(JSON.stringify({ packagedAsar: true, ...result }, null, 2));
  if (!result.ok || !result.aborted) throw new Error('Packaged archive reader failed');
} finally {
  clearTimeout(timer);
  child.kill();
  await exited;
}
