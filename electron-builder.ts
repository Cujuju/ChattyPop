import type { Configuration } from 'electron-builder';
import { appVersion } from './appVersion';

const config: Configuration = {
  appId: 'com.cujuju.chattypop',
  productName: 'ChattyPop',
  // package.json carries no version; the packaged app, installer and Windows file version take appVersion.ts's.
  extraMetadata: { version: appVersion(import.meta.dirname) },
  directories: {
    output: 'release',
    // icon.ico / icon.png (drawn from icon.svg); packaged beside the app for the tray, not inside it.
    buildResources: 'build',
  },
  files: [
    'out/**',
    'package.json',
  ],
  // Native deps ship Node-API prebuilds; no rebuild against Electron headers.
  npmRebuild: false,
  // Native SQLite prebuilds cannot load from inside an asar archive.
  asarUnpack: ['node_modules/better-sqlite3-multiple-ciphers/prebuilds/**'],
  // Only for latest*.yml, which installs from before @cujuju/electron-updates read; scripts/release.ts uploads them.
  publish: { provider: 'github', owner: 'Cujuju', repo: 'ChattyPop', releaseType: 'release' },
  win: {
    target: 'nsis',
    icon: 'build/icon.ico',
    // Tray icons load from disk; Windows .ico loading requires an unpacked file.
    extraResources: [{ from: 'build/icon.ico', to: 'icon.ico' }],
  },
  mac: {
    // The disk image is the first install; the zip is what the updater downloads (main/updates.ts).
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
    // Converted to .icns by electron-builder.
    icon: 'build/icon.png',
    category: 'public.app-category.social-networking',
    // Ad-hoc: Apple silicon runs no unsigned code, and no developer's certificate is used, even one in the builder's keychain.
    identity: '-',
    // The hardened runtime's library validation refuses the app's own frameworks under an ad-hoc signature; it serves notarization, which these builds skip.
    hardenedRuntime: false,
    // The architecture in every name: latest-mac.yml lists both, and the updater picks its own by it.
    artifactName: '${productName}-${version}-${arch}-mac.${ext}',
    // The menu-bar icon loads from disk (main/mainWindow.ts).
    extraResources: [{ from: 'build/icon.png', to: 'icon.png' }],
    // Why the embedded Discord client may ask for each: without the text macOS refuses the request outright.
    extendInfo: {
      NSMicrophoneUsageDescription: 'Discord uses the microphone for voice and video calls.',
      NSCameraUsageDescription: 'Discord uses the camera for video calls.',
      NSBluetoothAlwaysUsageDescription: 'Discord uses Bluetooth to sign in with a security key or a phone’s passkey.',
    },
  },
  dmg: {
    artifactName: '${productName}-${version}-${arch}.${ext}',
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
