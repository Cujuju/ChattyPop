// Which desktop this process runs on, for the few places the systems differ (window close, tray, icons, tool paths).
export const IS_WINDOWS = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';
