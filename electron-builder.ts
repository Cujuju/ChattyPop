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
  // The tray loads the icon by path (main/mainWindow.ts appIconPath); Windows reads .ico files from disk, not asar.
  extraResources: [{ from: 'build/icon.ico', to: 'icon.ico' }],
  // Native SQLite prebuilds cannot load from inside an asar archive.
  asarUnpack: ['node_modules/better-sqlite3-multiple-ciphers/prebuilds/**'],
  // Installers and latest.yml go to this public repo's releases, so the app updates (main/updates.ts) without a token.
  publish: { provider: 'github', owner: 'Cujuju', repo: 'ChattyPop', releaseType: 'release' },
  win: {
    target: 'nsis',
    icon: 'build/icon.ico',
  },
  // Per-user install (no admin prompt) with a choice of folder; Start menu and desktop shortcuts.
  nsis: {
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
