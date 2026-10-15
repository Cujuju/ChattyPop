// Which desktop this process runs on, for the few places the systems differ (window close, tray, icons, tool paths, secret storage).
export const IS_WINDOWS = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';
export const IS_LINUX = process.platform === 'linux';
