// macOS updates come from the GitHub release's zip, checked against latest-mac.yml and swapped in after the app exits.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appBundleOf, isNewerVersion, MacUpdater, parseLatestMac, replaceRefusal, swapScript, zipFor, type MacUpdaterOptions } from '../src/main/macUpdate';
import { tempDir } from './helpers';

/** latest-mac.yml as electron-builder 26 writes it for two architectures. */
const LATEST = `version: 0.460.2
files:
  - url: ChattyPop-0.460.2-arm64-mac.zip
    sha512: QUJD
    size: 120
  - url: ChattyPop-0.460.2-x64-mac.zip
    sha512: REVG
    size: 130
  - url: ChattyPop-0.460.2-arm64.dmg
    sha512: R0hJ
    size: 140
path: ChattyPop-0.460.2-arm64-mac.zip
sha512: QUJD
releaseDate: '2026-10-10T12:00:00.000Z'
`;

const IS_POSIX = process.platform !== 'win32';

describe('the macOS release file', () => {
  it('reads the version and each download', () => {
    const release = parseLatestMac(LATEST)!;
    expect(release.version).toBe('0.460.2');
    expect(release.files).toEqual([
      { url: 'ChattyPop-0.460.2-arm64-mac.zip', sha512: 'QUJD', size: 120 },
      { url: 'ChattyPop-0.460.2-x64-mac.zip', sha512: 'REVG', size: 130 },
      { url: 'ChattyPop-0.460.2-arm64.dmg', sha512: 'R0hJ', size: 140 },
    ]);
    expect(parseLatestMac('<html>Not Found</html>')).toBeNull();
  });

  it('picks the zip for this Mac’s processor, never the disk image', () => {
    const release = parseLatestMac(LATEST)!;
    expect(zipFor(release, 'arm64')?.url).toBe('ChattyPop-0.460.2-arm64-mac.zip');
    expect(zipFor(release, 'x64')?.url).toBe('ChattyPop-0.460.2-x64-mac.zip');
    expect(zipFor(release, 'ia32')).toBeUndefined();
  });

  it('compares versions by number, not by text', () => {
    expect(isNewerVersion('0.460.2', '0.457.19')).toBe(true);
    expect(isNewerVersion('0.457.20', '0.457.19')).toBe(true);
    expect(isNewerVersion('0.457.9', '0.457.19')).toBe(false);
    expect(isNewerVersion('0.457.19', '0.457.19')).toBe(false);
    expect(isNewerVersion('1.0', '0.999.999')).toBe(true);
  });
});

describe('the app bundle to replace', () => {
  it('is the .app the program runs from', () => {
    expect(appBundleOf('/Applications/ChattyPop.app/Contents/MacOS/ChattyPop')).toBe('/Applications/ChattyPop.app');
    expect(appBundleOf('/usr/local/bin/electron')).toBeNull();
  });

  it.runIf(IS_POSIX)('is refused where macOS runs a copy, or its folder can’t be written', async () => {
    const dir = tempDir();
    expect(await replaceRefusal(join(dir, 'ChattyPop.app'))).toBeNull();
    expect(await replaceRefusal('/private/var/folders/x/AppTranslocation/1234/d/ChattyPop.app')).toContain('Applications');
    expect(await replaceRefusal('/no/such/folder/ChattyPop.app')).toContain('can’t write');
  });
});

describe.runIf(IS_POSIX)('the swap', () => {
  /** A process that has already exited: the script's wait ends at once. */
  const exitedPid = (): number => spawnSync('/bin/sh', ['-c', 'exit 0']).pid;

  it('replaces the bundle with the staged one once the app has exited', () => {
    const dir = tempDir();
    const [app, staged] = [join(dir, 'Chatty Pop’s.app'), join(dir, 'updates', 'ChattyPop.app')];
    mkdirSync(app);
    mkdirSync(staged, { recursive: true });
    writeFileSync(join(app, 'v'), 'old');
    writeFileSync(join(staged, 'v'), 'new');
    execFileSync('/bin/sh', ['-c', swapScript(exitedPid(), app, staged, false)]);
    expect(readFileSync(join(app, 'v'), 'utf8')).toBe('new');
    expect(existsSync(staged)).toBe(false);
    expect(existsSync(`${app}.old`)).toBe(false);
  });

  it('puts the old bundle back when the staged one can’t be moved in', () => {
    const dir = tempDir();
    const app = join(dir, 'ChattyPop.app');
    mkdirSync(app);
    writeFileSync(join(app, 'v'), 'old');
    spawnSync('/bin/sh', ['-c', swapScript(exitedPid(), app, join(dir, 'missing.app'), false)]);
    expect(readFileSync(join(app, 'v'), 'utf8')).toBe('old');
  });

  it('opens the app again only for a restart', () => {
    expect(swapScript(1, '/a/X.app', '/b/X.app', true).split('\n').at(-1)).toBe("open '/a/X.app'");
    expect(swapScript(1, '/a/X.app', '/b/X.app', false)).not.toContain('open ');
  });
});

/** An updater for build `current` whose GitHub is `routes` (file name → body; absent = 404). */
function updater(current: string, routes: Record<string, string | Buffer>, over: Partial<MacUpdaterOptions> = {}) {
  const asked: string[] = [];
  const progress: number[] = [];
  const mac = new MacUpdater({
    repo: 'owner/app',
    currentVersion: current,
    arch: 'arm64',
    exe: '/Applications/ChattyPop.app/Contents/MacOS/ChattyPop',
    dir: join(tempDir(), 'updates'),
    fetch: async (url) => {
      asked.push(url);
      const body = routes[url.split('/').pop()!];
      return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
    },
    onProgress: (p) => progress.push(p),
    ...over,
  });
  return { mac, asked, progress };
}

describe('checking for a macOS update', () => {
  it('asks the repo’s latest release, and offers a newer version’s zip', async () => {
    const { mac, asked } = updater('0.457.19', { 'latest-mac.yml': LATEST });
    expect(await mac.newer()).toEqual({ version: '0.460.2', file: { url: 'ChattyPop-0.460.2-arm64-mac.zip', sha512: 'QUJD', size: 120 } });
    expect(asked).toEqual(['https://github.com/owner/app/releases/latest/download/latest-mac.yml']);
  });

  it('is up to date on the same or an older release, and while a release has no macOS build yet', async () => {
    expect(await updater('0.460.2', { 'latest-mac.yml': LATEST }).mac.newer()).toBeNull();
    expect(await updater('0.461.0', { 'latest-mac.yml': LATEST }).mac.newer()).toBeNull();
    expect(await updater('0.457.19', {}).mac.newer()).toBeNull();
  });

  it('fails when the release has no build for this Mac, or its file can’t be read', async () => {
    await expect(updater('0.457.19', { 'latest-mac.yml': LATEST }, { arch: 'ia32' }).mac.newer()).rejects.toThrow('no build for this Mac');
    await expect(updater('0.457.19', { 'latest-mac.yml': 'oops' }).mac.newer()).rejects.toThrow('couldn’t be read');
  });
});

describe.runIf(process.platform === 'darwin')('staging a macOS update', () => {
  /** A zip of a bundle named ChattyPop.app at `version`, as electron-builder's zip target packs one. */
  function releaseZip(version: string): Buffer {
    const dir = tempDir();
    const bundle = join(dir, 'ChattyPop.app');
    mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(join(bundle, 'Contents', 'MacOS', 'ChattyPop'), '#!/bin/sh\n');
    writeFileSync(join(bundle, 'Contents', 'Info.plist'), `<plist><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`);
    const zip = join(dir, 'app.zip');
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', bundle, zip]);
    return readFileSync(zip);
  }
  /** An install the test may replace: the bundle's folder, and the program's path in it. */
  function installed(): string {
    const exe = join(tempDir(), 'ChattyPop.app', 'Contents', 'MacOS', 'ChattyPop');
    mkdirSync(join(exe, '..'), { recursive: true });
    return exe;
  }
  const sha512 = (b: Buffer): string => createHash('sha512').update(b).digest('base64');

  it('downloads, checks and unpacks the bundle, reporting progress', async () => {
    const zip = releaseZip('0.460.2');
    const exe = installed();
    const { mac, progress } = updater('0.457.19', { 'app.zip': zip }, { exe });
    const staged = await mac.stage('0.460.2', { url: 'app.zip', sha512: sha512(zip), size: zip.length });
    expect(staged.appPath).toBe(appBundleOf(exe));
    expect(readFileSync(join(staged.staged, 'Contents', 'Info.plist'), 'utf8')).toContain('0.460.2');
    expect(progress.at(-1)).toBe(100);
  });

  it('refuses a download that doesn’t match the checksum, or isn’t the version named', async () => {
    const zip = releaseZip('0.460.2');
    const exe = installed();
    await expect(updater('0.457.19', { 'app.zip': zip }, { exe }).mac.stage('0.460.2', { url: 'app.zip', sha512: 'bm9wZQ==', size: zip.length })).rejects.toThrow('checksum');
    await expect(updater('0.457.19', { 'app.zip': zip }, { exe }).mac.stage('0.461.0', { url: 'app.zip', sha512: sha512(zip), size: zip.length })).rejects.toThrow('isn’t ChattyPop 0.461.0');
  });
});
