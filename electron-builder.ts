import type { Configuration } from 'electron-builder';
import { appVersion } from './appVersion';

const config: Configuration = {
  appId: 'com.cujuju.chattypop',
  productName: 'ChattyPop',
  // package.json carries no version; the packaged app, installer and Windows file version take appVersion.ts's.
  extraMetadata: { version: appVersion(import.meta.dirname) },
  directories: {
    output: 'release',
    // icon.ico / icon.png (drawn from icon.svg); not packaged into the app itself.
    buildResources: 'build',
  },
  files: [
    'out/**',
    'package.json',
  ],
  // Native deps ship Node-API prebuilds; no rebuild against Electron headers.
  npmRebuild: false,
  // Tray icons load from disk; Windows .ico loading requires an unpacked file.
  extraResources: [{ from: 'build/icon.ico', to: 'icon.ico' }],
  // Native SQLite prebuilds cannot load from inside an asar archive.
  asarUnpack: ['node_modules/better-sqlite3-multiple-ciphers/prebuilds/**'],
  // Publishes installers and latest.yml to public releases for token-free updates.
  publish: { provider: 'github', owner: 'Cujuju', repo: 'ChattyPop', releaseType: 'release' },
  win: {
    target: 'nsis',
    icon: 'build/icon.ico',
  },
  // Per-user install (no admin prompt) with a choice of folder; Start menu and desktop shortcuts.
  nsis: {
    // No spaces: the release uploads it under this name, which latest.yml's url must match.
    artifactName: '${productName}-Setup-${version}.${ext}',
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'ChattyPop',
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
  },
};

export default config;
