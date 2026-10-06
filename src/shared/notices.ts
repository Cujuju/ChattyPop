// Notices: what a notification says, once, for every surface that shows one (Windows toasts, phone pushes).
import type { AppEvent } from './contract';
import { PLUGIN_ID_SOURCE } from './plugins';
import { stampedName, type PluginDescriptor } from './bundledTypes';

/** The host's own notice kinds: a plugin's notification that names no kind of its own. */
export const HOST_NOTICE_KINDS = ['plugin'] as const;
export type HostNoticeKind = (typeof HOST_NOTICE_KINDS)[number];
/** What a notice is about; each phone chooses which of these it is sent. A plugin's are `<plugin id>.<kind>` (descriptor `notices`). */
export type NoticeKind = HostNoticeKind | `${string}.${string}`;

/** A plugin's stamped notice kind. */
const STAMPED_KIND = new RegExp(`^${PLUGIN_ID_SOURCE}\\.[a-zA-Z][a-zA-Z0-9_]*$`);
/** Whether `v` has a notice kind's shape: the host's, or any plugin's stamped one, installed or not. */
export const isNoticeKind = (v: unknown): v is NoticeKind =>
  typeof v === 'string' && ((HOST_NOTICE_KINDS as readonly string[]).includes(v) || STAMPED_KIND.test(v));

/** A kind a phone chose before a plugin owned it (adopts.noticeKinds maps it on): an identifier. */
const PRE_PLUGIN_KIND = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/** Applies plugin notice aliases once. Preserves undeclared string kinds for absent plugins; drops other values. */
export function adoptNoticeKinds(plugins: readonly PluginDescriptor[], kinds: readonly unknown[]): string[] {
  const aliases = new Map<string, string>(
    plugins.flatMap((p) => Object.entries(p.adopts?.noticeKinds ?? {}).map(([old, kind]) => [old, stampedName(p.manifest.id, kind)] as const)),
  );
  const kept = kinds.filter((k): k is string => isNoticeKind(k) || (typeof k === 'string' && PRE_PLUGIN_KIND.test(k)));
  return [...new Set(kept.map((k) => aliases.get(k) ?? k))];
}

/** Whether notice kind `kind` is one of `plugins`' declared privacy-scoped kinds (notices[].privacyScoped), stamped. */
export const privacyScopedIn = (plugins: readonly PluginDescriptor[], kind: string): boolean =>
  plugins.some((p) => p.notices?.some((n) => n.privacyScoped === true && stampedName(p.manifest.id, n.kind) === kind) === true);

/** A notice; a plugin's names one of its declared kinds (`K`), which the host stamps when it is shown. */
export interface Notice<K extends string = NoticeKind> {
  kind: K;
  title: string;
  body: string;
  /** The message a click opens; null opens the app as it was. */
  open: { channelId: string; messageId: string } | null;
}

/** The notices `e` warrants, before anyone's settings; empty for events that notify no one. */
export function noticesFor(e: AppEvent): Notice[] {
  if (e.type === 'plugin-notify') {
    return [{ kind: 'plugin', title: e.title, body: e.body, open: e.channelId && e.messageId ? { channelId: e.channelId, messageId: e.messageId } : null }];
  }
  return [];
}
