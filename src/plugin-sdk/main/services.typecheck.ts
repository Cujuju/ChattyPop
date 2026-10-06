// Compile-time main SDK probe: interfaces replace host classes; Discord write methods require declared write permission.
import { definePlugin, typedMentions } from '@plugin-sdk/shared';
import { defineMainPlugin, sendMessage, uploadFiles, type MainContext } from '@plugin-sdk/main';
// @ts-expect-error The host's Discord client class is not an SDK export.
import type { DiscordApi } from '@plugin-sdk/main';
import type { DiscordApi as HostDiscordApi } from '@main/discord/api';
import type { GuildEmojiIndex } from '@main/discord/guildEmojis';

/** True when `A` is assignable to `B`; a class with private members is assignable only from itself. */
type Assignable<A, B> = [A] extends [B] ? true : false;

const reader = definePlugin({ manifest: { id: 'reader', name: 'Reader', version: '1', description: '' } });
const writer = definePlugin({ manifest: { id: 'writer', name: 'Writer', version: '1', description: '' }, discord: { write: true } });

// No context member is a host class.
export const readerNotHost: Assignable<MainContext<typeof reader>['discord'], HostDiscordApi> = false;
export const writerNotHost: Assignable<MainContext<typeof writer>['discord'], HostDiscordApi> = false;
export const emojisNotHost: Assignable<MainContext['emojis'], GuildEmojiIndex> = false;

const message = { content: 'hi', allowedMentions: typedMentions(false) };

export const probeReader = defineMainPlugin(reader, (ctx) => {
  void ctx.discord.get('users/@me');
  // @ts-expect-error A plugin without discord.write has no write methods.
  void ctx.discord.post('channels/1/messages', {});
  // @ts-expect-error Nor can it post through the SDK's helpers.
  void sendMessage(ctx.discord, '1', message);
  // @ts-expect-error Nor upload.
  void uploadFiles(ctx.discord, '1', []);
});

export const probeWriter = defineMainPlugin(writer, (ctx) => {
  void ctx.discord.get('users/@me');
  void ctx.discord.patch('channels/1/messages/2', {});
  void sendMessage(ctx.discord, '1', message);
  void uploadFiles(ctx.discord, '1', []);
});
