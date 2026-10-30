// Signs and publishes updates from this machine (README → Releases):
//   pnpm release keygen | nightly [--dry-run] | promote <version> [--dry-run]
// The private key stays outside the repo: $CHATTYPOP_UPDATE_KEY or ~/.config/chattypop/update_key.
import os from 'node:os';
import path from 'node:path';
import { runReleaseCli } from '@cujuju/electron-updates/node';
import { appVersion } from '../appVersion';
import { UPDATE_REPO, UPDATE_SIGNATURE_CONTEXT } from '../src/shared/updateFeed';

const APP_NAME = 'ChattyPop';
/** The macOS architectures electron-builder.ts packages. */
const MAC_ARCHS = ['arm64', 'x64'];

export async function main(args: string[]): Promise<number> {
  const root = process.cwd();
  await runReleaseCli(
    {
      appName: APP_NAME,
      repo: UPDATE_REPO,
      signatureContext: UPDATE_SIGNATURE_CONTEXT,
      dist: path.join(root, 'release'),
      publicKeyFile: path.join(root, 'build', 'update-public-key.pem'),
      keyFile: process.env['CHATTYPOP_UPDATE_KEY'] || path.join(os.homedir(), '.config', 'chattypop', 'update_key'),
      version: () => appVersion(root),
      archs: { win32: ['x64'], darwin: MAC_ARCHS },
      // electron-builder.ts artifact names.
      updateFile: (platform, arch, v) => (platform === 'win32' ? `${APP_NAME}-Setup-${v}.exe` : `${APP_NAME}-${v}-${arch}-mac.zip`),
      // Disk images (first installs), and the electron-builder feeds that installs from before this updater read.
      extraFiles: (platform, v) =>
        platform === 'win32' ? ['latest.yml', `${APP_NAME}-Setup-${v}.exe.blockmap`] : [...MAC_ARCHS.map((arch) => `${APP_NAME}-${v}-${arch}.dmg`), 'latest-mac.yml'],
      tagSourceCommit: true,
    },
    args,
  );
  return 0;
}
