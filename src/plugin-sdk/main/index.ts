// Plugin SDK, main part (docs/plugin-architecture.md §4–§5): the main side's context, and Discord posting through the
// embedded session (law 4).
import type { PluginDescriptor } from '@shared/bundledTypes';
import type { MainContext, MainPlugin } from '@main/plugins/context';

export type { MainContext, MainPlugin } from '@main/plugins/context';
export type { Notifications, NotificationRequest, NotificationTarget } from '@shared/notifications';
export type { AttachmentFetch } from '@main/media/attachmentDownloader';

/** A plugin's main side. `activate` runs once at startup; the plugin's switch stops its core and renderer sides, which make its requests. */
export const defineMainPlugin = <const D extends PluginDescriptor>(plugin: D, activate: (ctx: MainContext<D>) => void): MainPlugin<D> => ({ plugin, activate });

export type { DiscordClient, DiscordQuery, DiscordReader, DiscordWriter } from '@main/discord/client';
export type { GuildEmojis, PluginDiscord } from '@main/plugins/discordContext';
export { sendMessage, uploadFiles, type OutgoingFile } from '@main/discord/send';

export type { Notice } from '@shared/notices';
export { notificationRequest } from '@shared/notifications';
/** A phone's stored notice choices with the installed plugins' aliases (adopts.noticeKinds) applied. */
export { adoptedNoticeKinds } from '@shared/bundledPlugins';

export { PluginInactiveError } from '@shared/pluginCall';

// The phone (a transport plugin and phone routes) and main-side resources.
export type { PhoneGateway, PhoneRoute, PhoneRouteRequest, PhoneTransport } from '@main/phone/hub';
export { PhoneCallRefused, PhoneRouteMissing } from '@main/phone/hub';
// What ctx.pdf draws: an export's document and the width it lays out at.
export type { PdfSource } from '@shared/htmlPage';
export type { LoopbackHandler, LoopbackServer } from '@main/plugins/loopback';
export { TailnetError } from '@main/tailnet';
export type { ActiveResource, ResourceRun } from '@main/plugins/context';
export type { Dispose, StopReason } from '@main/plugins/states';
export type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
export type { DeliveredNotification } from '@shared/notifications';
export type { AppEvent } from '@shared/contract';
export type { PhoneCall } from '@shared/phone';

/** Finds a program on PATH (the Windows .exe name there). */
export { IS_WINDOWS, findExecutable } from '@core/ai/resolveCli';
/** The host's stylesheet for a server-rendered page shown before the app (pairing): the owner's theme, no script. */
export { default as pairPageCss } from '../../renderer/src/theme/pair.css?inline';
