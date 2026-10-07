// The iPhone shell's pairing link, user-agent marker, bundle id and push environment. No imports: capacitor.config.ts loads this through Node's
// own TypeScript stripping, which can't resolve the app's path aliases.
/** `chattypop://pair?origin=<https origin>&code=<digits>`, which the app handles (ios/App/App/ShellViewController.swift). */
export const SHELL_SCHEME = 'chattypop';
export const SHELL_LINK_HOST = 'pair';
export const SHELL_LINK_PARAMS = { origin: 'origin', code: 'code' } as const;
/** The link that pairs the app with the desktop at `origin`: the pairing page's app button and the desktop's app QR. */
export const shellPairLink = (origin: string, code: string): string =>
  `${SHELL_SCHEME}://${SHELL_LINK_HOST}?${new URLSearchParams({ [SHELL_LINK_PARAMS.origin]: origin, [SHELL_LINK_PARAMS.code]: code })}`;
/** Appended to the shell's user agent, so the pairing page knows it's already in the app. */
export const SHELL_USER_AGENT_TOKEN = 'ChattyPopShell';
/** The app's bundle id: capacitor.config.ts's appId, and the topic the desktop's APNs pushes name. */
export const SHELL_BUNDLE_ID = 'com.cujuju.chattypop';
/** APNs environments, as the app's `aps-environment` entitlement names them: Xcode builds use development. */
export const APNS_ENVIRONMENTS = ['development', 'production'] as const;
export type ApnsEnvironment = (typeof APNS_ENVIRONMENTS)[number];
export const isApnsEnvironment = (v: unknown): v is ApnsEnvironment => (APNS_ENVIRONMENTS as readonly unknown[]).includes(v);
/** Global the app sets before the page loads (ShellViewController.swift): `{ apsEnvironment: ApnsEnvironment }`. */
export const SHELL_NATIVE_GLOBAL = 'chattyPopShell';
/** Custom properties the app sets on `<html>` as the keyboard moves (ShellViewController.swift; the theme's sizes.css reads them). */
export const SHELL_KEYBOARD_PROPERTIES = { inset: '--cp-keyboard-inset', duration: '--cp-keyboard-duration' } as const;
/** Window CustomEvent the app dispatches on each network change and in reply to SHELL_NETWORK_HANDLER, detail a ShellNetworkDetail (state/network.ts). */
export const SHELL_NETWORK_EVENT = 'cp-shell-network';
/** Native script message handler the page posts `{}` to for the current SHELL_NETWORK_EVENT. */
export const SHELL_NETWORK_HANDLER = 'shellNetwork';
export interface ShellNetworkDetail {
  cellular: boolean;
}
export const isShellNetworkDetail = (v: unknown): v is ShellNetworkDetail =>
  typeof v === 'object' && v !== null && typeof (v as { cellular?: unknown }).cellular === 'boolean';
/** The app's handler that saves a camera capture to Photos (ShellMediaSaver.swift). Its postMessage resolves once a piece is written; the last piece's once saved. */
export const SHELL_SAVE_MEDIA_HANDLER = 'shellSaveMedia';
/** One piece of a capture sent to SHELL_SAVE_MEDIA_HANDLER. Pieces go in order from index 0; a new index 0 abandons any unfinished capture. */
export interface ShellMediaPiece {
  /** Names the capture; every piece of it carries the same one. */
  id: string;
  index: number;
  last: boolean;
  /** The capture's MIME type, e.g. `image/jpeg`, `video/quicktime`. */
  type: string;
  /** This piece's bytes, base64. */
  data: string;
}
